export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const offset = parseInt(req.query.offset) || 0; 
  const batchSize = 3; 
  
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 

  // --- HELPER FUNCTION: Title Normalizer for Fuzzy Matching ---
  // Converts "The River /" and "The River: A Novel" both into "theriver"
  function normalizeTitle(title) {
      if (!title) return "";
      return String(title)
          .split('/')[0]      // Remove Koha trailing slashes
          .split(':')[0]      // Remove subtitles
          .toLowerCase()      // Make lowercase
          .replace(/[^a-z0-9]/g, ''); // Remove all spaces and punctuation
  }

  // --- 1. THE BACKEND DATA PROCESSOR ---
  if (req.query.mode === 'data') {
    try {
      const kohaResponse = await fetch(KOHA_JSON_URL);
      const kohaData = await kohaResponse.json();
      
      let ownedIsbns = [];
      let ownedTitles = []; // New array to store titles

      if (kohaData.length > 1 && Array.isArray(kohaData[0])) {
        kohaData.slice(1).forEach(row => {
            const isbnStr = row[0] ? String(row[0]).replace(/-/g, '').trim() : '';
            const rawTitle = row[1] ? String(row[1]) : '';
            
            if (isbnStr) ownedIsbns.push(isbnStr);
            
            const cleanTitle = normalizeTitle(rawTitle);
            if (cleanTitle) ownedTitles.push(cleanTitle);
        });
      }

      const batchToProcess = ownedIsbns.slice(offset, offset + batchSize);
      const results = [];
      const logs = []; 

      for (const currentIsbn of batchToProcess) {
          await new Promise(resolve => setTimeout(resolve, 1000));

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

          const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=35`);
          const seriesData = await seriesRes.json();
          const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

          let missingCount = 0;
          for (const book of seriesTitles) {
              const bookIsbns = book.industryIdentifiers 
                  ? book.industryIdentifiers.map(id => id.identifier) 
                  : [];
              
              const gCleanTitle = normalizeTitle(book.title);

              // THE NEW CHECK: Is it owned by Title OR by ISBN?
              const isOwnedByTitle = gCleanTitle !== '' && ownedTitles.includes(gCleanTitle);
              const isOwnedByIsbn = bookIsbns.some(isbn => ownedIsbns.includes(isbn));
              
              const isOwned = isOwnedByTitle || isOwnedByIsbn;

              if (!isOwned && book.title) {
                  results.push({
                      author: author,
                      title: book.title,
                      year: book.publishedDate || "??",
                      isbns: bookIsbns.slice(0, 1).join('') || "N/A"
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
        button.start-btn { background: #2ecc71; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: bold;}
        button.start-btn:disabled { background: #95a5a6; cursor: not-allowed; }
        .status-text { font-weight: bold; color: #7f8c8d; margin-bottom: 20px; }
        
        /* Layout */
        .dashboard-grid { display: flex; gap: 30px; margin-top: 20px; align-items: flex-start;}
        .results-section { flex: 2; display: flex; flex-direction: column; gap: 10px; }
        .log-section { flex: 1; background: #1e272e; color: #00d2d3; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 13px; height: 600px; overflow-y: auto; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);}
        
        /* Accordion UI */
        .accordion { background-color: #f8f9fa; color: #2c3e50; cursor: pointer; padding: 15px; width: 100%; border: 1px solid #e0e0e0; text-align: left; outline: none; font-size: 16px; font-weight: bold; border-radius: 6px; transition: 0.3s; display: flex; justify-content: space-between; align-items: center;}
        .accordion:hover { background-color: #e9ecef; }
        .accordion.active { background-color: #3498db; color: white; border-color: #3498db; border-bottom-left-radius: 0; border-bottom-right-radius: 0;}
        .panel { padding: 0; background-color: white; display: none; overflow: hidden; border: 1px solid #e0e0e0; border-top: none; border-bottom-left-radius: 6px; border-bottom-right-radius: 6px; }
        
        /* Internal Table */
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px 15px; border-bottom: 1px solid #eee; }
        th { background: #fbfcfc; font-size: 14px; color: #7f8c8d;}
        tr:last-child td { border-bottom: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Author Gap Analyzer (Title-Matching Enabled)</h1>
        <p>Analyzing collection code: <strong>${collectionCode}</strong></p>
        
        <div id="controls">
          <button id="start-btn" class="start-btn" onclick="startAnalysis()">Start Live Scan</button>
        </div>

        <div id="progress-container"><div id="progress-bar"></div></div>
        <div id="status" class="status-text">Awaiting startup...</div>

        <div class="dashboard-grid">
          <div class="results-section" id="results-container">
            </div>
          
          <div class="log-section" id="live-logs">
            <span style="color: #fff;">System Logs Initialized...</span><br>
            <span style="color: #f39c12;">✓ Title deduplication active (ignoring format editions)</span><br>
            <span style="color: #f39c12;">✓ Koha series-only filter active</span><br><br>
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
          logBox.scrollTop = logBox.scrollHeight; 
        }

        async function runBatch() {
          const status = document.getElementById('status');
          const resultsContainer = document.getElementById('results-container');
          
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

            // Append Grouped Results
            if (data.results && data.results.length > 0) {
                data.results.forEach(book => {
                  const safeAuthorId = "group-" + book.author.replace(/[^a-zA-Z0-9]/g, "");
                  
                  let groupBtn = document.getElementById("btn-" + safeAuthorId);
                  let groupPanel = document.getElementById("panel-" + safeAuthorId);

                  if (!groupBtn) {
                      groupBtn = document.createElement("button");
                      groupBtn.id = "btn-" + safeAuthorId;
                      groupBtn.className = "accordion";
                      groupBtn.dataset.count = 0; 
                      
                      groupBtn.onclick = function() {
                          this.classList.toggle("active");
                          let panel = this.nextElementSibling;
                          if (panel.style.display === "block") {
                              panel.style.display = "none";
                          } else {
                              panel.style.display = "block";
                          }
                      };

                      groupPanel = document.createElement("div");
                      groupPanel.id = "panel-" + safeAuthorId;
                      groupPanel.className = "panel";
                      groupPanel.innerHTML = \`<table><thead><tr><th>Missing Title</th><th>Year</th><th>ISBN</th></tr></thead><tbody></tbody></table>\`;
                      
                      resultsContainer.appendChild(groupBtn);
                      resultsContainer.appendChild(groupPanel);
                  }

                  let currentCount = parseInt(groupBtn.dataset.count) + 1;
                  groupBtn.dataset.count = currentCount;
                  groupBtn.innerHTML = \`<span>\${book.author}</span> <span>\${currentCount} Missing Volumes ▾</span>\`;

                  const tbody = groupPanel.querySelector("tbody");
                  const row = tbody.insertRow();
                  row.innerHTML = \`<td>\${book.title}</td><td>\${book.year}</td><td>\${book.isbns}</td>\`;
                });
            }

            if (!data.done) {
              setTimeout(runBatch, 500); 
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
