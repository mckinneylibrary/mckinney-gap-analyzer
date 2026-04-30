export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const offset = parseInt(req.query.offset) || 0; 
  const batchSize = 3; // Reduced to 3 to ensure we respect Google's API speed limits
  
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 

  // --- 1. THE BACKEND DATA PROCESSOR ---
  if (req.query.mode === 'data') {
    try {
      const kohaResponse = await fetch(KOHA_JSON_URL);
      const kohaData = await kohaResponse.json();
      
      let ownedIsbns = [];
      if (kohaData.length > 1 && Array.isArray(kohaData[0])) {
        ownedIsbns = kohaData.slice(1).map(row => {
            const isbnStr = row[0] ? String(row[0]) : '';
            return isbnStr.replace(/-/g, '').trim();
        }).filter(isbn => isbn !== '');
      }

      const batchToProcess = ownedIsbns.slice(offset, offset + batchSize);
      const results = [];
      const logs = []; // New logging system

      for (const currentIsbn of batchToProcess) {
          // THE THROTTLE: Pause for 1 second to prevent API rate-limit blocking
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Query Google Books
          const googleBookRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${currentIsbn}`);
          const googleBookData = await googleBookRes.json();

          if (!googleBookData.items || googleBookData.items.length === 0) {
              logs.push(`[SKIP] ISBN ${currentIsbn}: Not found in Google database.`);
              continue;
          }

          const author = googleBookData.items[0].volumeInfo.authors ? googleBookData.items[0].volumeInfo.authors[0] : "";
          if (!author) {
              logs.push(`[SKIP] ISBN ${currentIsbn}: No author listed.`);
              continue;
          }

          // Fetch the Author's other works
          const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=35`);
          const seriesData = await seriesRes.json();
          const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

          let missingCount = 0;
          for (const book of seriesTitles) {
              const bookIsbns = book.industryIdentifiers 
                  ? book.industryIdentifiers.map(id => id.identifier) 
                  : [];
              
              const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

              // If it's missing, add it to our list
              if (!isOwned && book.title) {
                  results.push({
                      author: author,
                      title: book.title,
                      year: book.publishedDate || "??",
                      isbns: bookIsbns.slice(0, 1).join('')
                  });
                  missingCount++;
              }
          }
          logs.push(`[SUCCESS] Analyzed ${author}: Found ${missingCount} missing titles.`);
      }

      return res.status(200).json({
        results: results,
        logs: logs,
        nextOffset: offset + batchSize,
        total: ownedIsbns.length,
        done: (offset + batchSize) >= ownedIsbns.length
      });

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // --- 2. THE FRONTEND DASHBOARD ---
  const htmlOutput = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Collection Gap Runner</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 30px; background: #f4f7f6; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
        h1 { margin-top: 0; color: #2c3e50; }
        #progress-container { background: #eee; height: 20px; border-radius: 10px; margin: 20px 0; overflow: hidden; display: none; }
        #progress-bar { background: #3498db; width: 0%; height: 100%; transition: width 0.3s; }
        button { background: #2ecc71; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: bold;}
        button:disabled { background: #95a5a6; cursor: not-allowed; }
        .status-text { font-weight: bold; color: #7f8c8d; margin-bottom: 20px; }
        
        /* Layout for Table and Logs */
        .dashboard-grid { display: flex; gap: 30px; margin-top: 20px; align-items: flex-start;}
        .table-section { flex: 2; overflow-x: auto;}
        .log-section { flex: 1; background: #1e272e; color: #00d2d3; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 13px; height: 600px; overflow-y: auto; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);}
        
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; position: sticky; top: 0;}
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Author Gap Analyzer</h1>
        <p>Analyzing collection code: <strong>${collectionCode}</strong></p>
        
        <div id="controls">
          <button id="start-btn" onclick="startAnalysis()">Start Live Scan</button>
        </div>

        <div id="progress-container"><div id="progress-bar"></div></div>
        <div id="status" class="status-text">Awaiting startup...</div>

        <div class="dashboard-grid">
          <div class="table-section">
            <table id="results-table">
              <thead>
                <tr><th>Author</th><th>Missing Title</th><th>Year</th><th>ISBN</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          
          <div class="log-section" id="live-logs">
            <span style="color: #fff;">System Logs Initialized...</span><br><br>
          </div>
        </div>
      </div>

      <script>
        let currentOffset = 0;
        const ccode = "${collectionCode}";
        let isRunning = false;

        async function startAnalysis() {
          if(isRunning) return;
          isRunning = true;
          document.getElementById('start-btn').disabled = true;
          document.getElementById('progress-container').style.display = 'block';
          runBatch();
        }

        function appendLog(message) {
          const logBox = document.getElementById('live-logs');
          logBox.innerHTML += message + "<br>";
          logBox.scrollTop = logBox.scrollHeight; // Auto-scroll to bottom
        }

        async function runBatch() {
          const status = document.getElementById('status');
          const tableBody = document.querySelector('#results-table tbody');
          
          try {
            const response = await fetch(\`/api/analyzer?mode=data&ccode=\${ccode}&offset=\${currentOffset}\`);
            const data = await response.json();

            if(data.error) throw new Error(data.error);

            // Update Progress
            currentOffset = data.nextOffset;
            const percent = Math.min(100, Math.round((currentOffset / data.total) * 100));
            document.getElementById('progress-bar').style.width = percent + '%';
            status.innerText = "Processing batch... (" + Math.min(currentOffset, data.total) + " of " + data.total + " items checked)";

            // Update Logs
            if (data.logs && data.logs.length > 0) {
                data.logs.forEach(log => appendLog(log));
            }

            // Append Table Results
            if (data.results && data.results.length > 0) {
                data.results.forEach(book => {
                  const row = tableBody.insertRow();
                  row.innerHTML = "<td><b>"+book.author+"</b></td><td>"+book.title+"</td><td>"+book.year+"</td><td>"+book.isbns+"</td>";
                });
            }

            // Loop or Finish
            if (!data.done) {
              setTimeout(runBatch, 500); // Small pause before asking Vercel for next batch
            } else {
              status.innerText = "Analysis Complete! Checked " + data.total + " items.";
              status.style.color = "#27ae60";
              appendLog("<span style='color: #2ecc71;'>[SYSTEM] Scan successfully completed.</span>");
            }
          } catch (err) {
            status.innerText = "System Halted: " + err.message;
            status.style.color = "#e74c3c";
            appendLog("<span style='color: #e74c3c;'>[ERROR] " + err.message + "</span>");
            document.getElementById('start-btn').disabled = false;
            isRunning = false;
          }
        }
      </script>
    </body>
    </html>
  `;

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(htmlOutput);
}
