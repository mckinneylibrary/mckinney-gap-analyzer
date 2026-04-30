export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const offset = parseInt(req.query.offset) || 0; // Where to start in the list
  const batchSize = 5; // How many books to check per "cycle"
  
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 

  // --- 1. IF THIS IS AN API CALL (Asking for Data) ---
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

      for (const currentIsbn of batchToProcess) {
          const olRes = await fetch(`https://openlibrary.org/search.json?q=isbn:${currentIsbn}`);
          const olData = await olRes.json();
          if (!olData.docs || olData.docs.length === 0) continue;

          const bookDoc = olData.docs[0];
          const seriesList = bookDoc.series || [];
          if (seriesList.length === 0) continue; 

          const seriesName = seriesList[0];
          const author = bookDoc.author_name ? bookDoc.author_name[0] : "";

          const authorRes = await fetch(`https://openlibrary.org/search.json?author="${encodeURIComponent(author)}"&limit=100`);
          const authorData = await authorRes.json();
          const seriesBooks = (authorData.docs || []).filter(b => b.series && b.series.includes(seriesName));

          for (const book of seriesBooks) {
              const cleanBookIsbns = (book.isbn || []).map(id => id.replace(/-/g, '').trim());
              const isOwned = cleanBookIsbns.some(isbn => ownedIsbns.includes(isbn));

              if (!isOwned) {
                  results.push({
                      series: seriesName,
                      title: book.title,
                      author: author,
                      year: book.first_publish_year || "??",
                      isbns: cleanBookIsbns.slice(0, 1).join('')
                  });
              }
          }
      }

      return res.status(200).json({
        results: results,
        nextOffset: offset + batchSize,
        total: ownedIsbns.length,
        done: (offset + batchSize) >= ownedIsbns.length
      });

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // --- 2. IF THIS IS A PAGE LOAD (The UI) ---
  const htmlOutput = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Series Gap Runner</title>
      <style>
        body { font-family: sans-serif; padding: 40px; background: #f4f7f6; color: #333; }
        .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
        h1 { margin-top: 0; }
        #progress-container { background: #eee; height: 20px; border-radius: 10px; margin: 20px 0; overflow: hidden; display: none; }
        #progress-bar { background: #3498db; width: 0%; height: 100%; transition: width 0.3s; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f9f9f9; }
        button { background: #2ecc71; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; }
        button:disabled { background: #ccc; }
        .status-text { font-weight: bold; color: #7f8c8d; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Series Gap Analyzer</h1>
        <p>This tool cycles through your collection in batches of 5 to avoid timeouts.</p>
        
        <div id="controls">
          <button id="start-btn" onclick="startAnalysis()">Start Full Collection Scan</button>
        </div>

        <div id="progress-container"><div id="progress-bar"></div></div>
        <div id="status" class="status-text">Ready to begin...</div>

        <table id="results-table">
          <thead>
            <tr><th>Series</th><th>Missing Title</th><th>Author</th><th>Year</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <script>
        let currentOffset = 0;
        const ccode = "${collectionCode}";

        async function startAnalysis() {
          document.getElementById('start-btn').disabled = true;
          document.getElementById('progress-container').style.display = 'block';
          runBatch();
        }

        async function runBatch() {
          const status = document.getElementById('status');
          const tableBody = document.querySelector('#results-table tbody');
          
          try {
            const response = await fetch(\`/api/analyzer?mode=data&ccode=\${ccode}&offset=\${currentOffset}\`);
            const data = await response.json();

            // 1. Update Progress
            currentOffset = data.nextOffset;
            const percent = Math.min(100, Math.round((currentOffset / data.total) * 100));
            document.getElementById('progress-bar').style.size = percent + '%';
            document.getElementById('progress-bar').style.width = percent + '%';
            status.innerText = "Analyzing items " + currentOffset + " of " + data.total + "...";

            // 2. Append Results
            data.results.forEach(book => {
              const row = tableBody.insertRow();
              row.innerHTML = "<td><b>"+book.series+"</b></td><td>"+book.title+"</td><td>"+book.author+"</td><td>"+book.year+"</td>";
            });

            // 3. Check if we should continue
            if (!data.done) {
              runBatch(); // Auto-start next cycle
            } else {
              status.innerText = "Analysis Complete! Checked " + data.total + " items.";
              status.style.color = "#27ae60";
            }
          } catch (err) {
            status.innerText = "Error: " + err.message;
            status.style.color = "#e74c3c";
          }
        }
      </script>
    </body>
    </html>
  `;

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(htmlOutput);
}
