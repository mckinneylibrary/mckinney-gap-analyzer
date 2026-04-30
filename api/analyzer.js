export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 

  // --- 1. THE BACKEND: Fetch Koha Data Only ---
  if (req.query.mode === 'koha') {
    try {
      const kohaResponse = await fetch(KOHA_JSON_URL);
      if (!kohaResponse.ok) throw new Error(`Koha API Error: ${kohaResponse.status}`);
      
      const kohaText = await kohaResponse.text();
      const kohaData = JSON.parse(kohaText);
      
      let ownedIsbns = [];
      if (kohaData.length > 1 && Array.isArray(kohaData[0])) {
        ownedIsbns = kohaData.slice(1).map(row => {
            const isbnStr = row[0] ? String(row[0]) : '';
            return isbnStr.replace(/-/g, '').trim();
        }).filter(isbn => isbn !== '');
      }

      return res.status(200).json({ isbns: ownedIsbns });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // --- 2. THE FRONTEND: Browser processes Open Library Data ---
  const htmlOutput = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Series Gap Runner (Open Library)</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 30px; background: #f4f7f6; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
        h1 { margin-top: 0; color: #2c3e50; }
        #progress-container { background: #eee; height: 20px; border-radius: 10px; margin: 20px 0; overflow: hidden; display: none; }
        #progress-bar { background: #9b59b6; width: 0%; height: 100%; transition: width 0.3s; }
        button.start-btn { background: #8e44ad; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: bold;}
        button.start-btn:disabled { background: #95a5a6; cursor: not-allowed; }
        .status-text { font-weight: bold; color: #7f8c8d; margin-bottom: 20px; }
        
        .dashboard-grid { display: flex; gap: 30px; margin-top: 20px; align-items: flex-start;}
        .results-section { flex: 2; display: flex; flex-direction: column; gap: 10px; }
        .log-section { flex: 1; background: #1e272e; color: #00d2d3; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 13px; height: 600px; overflow-y: auto; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);}
        
        .accordion { background-color: #f8f9fa; color: #2c3e50; cursor: pointer; padding: 15px; width: 100%; border: 1px solid #e0e0e0; text-align: left; outline: none; font-size: 16px; font-weight: bold; border-radius: 6px; transition: 0.3s; display: flex; justify-content: space-between; align-items: center;}
        .accordion:hover { background-color: #e9ecef; }
        .accordion.active { background-color: #8e44ad; color: white; border-color: #8e44ad; border-bottom-left-radius: 0; border-bottom-right-radius: 0;}
        .panel { padding: 0; background-color: white; display: none; overflow: hidden; border: 1px solid #e0e0e0; border-top: none; border-bottom-left-radius: 6px; border-bottom-right-radius: 6px; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px 15px; border-bottom: 1px solid #eee; }
        th { background: #fbfcfc; font-size: 14px; color: #7f8c8d;}
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Series Gap Analyzer (Open Library Mode)</h1>
        <p>Analyzing collection code: <strong>${collectionCode}</strong></p>
        
        <div id="controls">
          <button id="start-btn" class="start-btn" onclick="startAnalysis()">Start Live Scan</button>
        </div>

        <div id="progress-container"><div id="progress-bar"></div></div>
        <div id="status" class="status-text">Awaiting startup...</div>

        <div class="dashboard-grid">
          <div class="results-section" id="results-container"></div>
          <div class="log-section" id="live-logs">
            <span style="color: #fff;">System Logs Initialized...</span><br><br>
          </div>
        </div>
      </div>

      <script>
        const ccode = "${collectionCode}";
        let ownedIsbns = [];
        let isRunning = false;
        let currentIndex = 0;
        
        // Cache to remember which series we have already processed
        const analyzedSeriesCache = new Set(); 
        
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        function appendLog(message) {
          const logBox = document.getElementById('live-logs');
          logBox.innerHTML += message + "<br>";
          logBox.scrollTop = logBox.scrollHeight; 
        }

        async function startAnalysis() {
          if(isRunning) return;
          isRunning = true;
          document.getElementById('start-btn').disabled = true;
          document.getElementById('progress-container').style.display = 'block';
          const status = document.getElementById('status');
          
          try {
              status.innerText = "Fetching master ISBN list from Koha...";
              const kohaRes = await fetch(\`/api/analyzer?mode=koha&ccode=\${ccode}\`);
              const kohaData = await kohaRes.json();
              
              if(kohaData.error) throw new Error(kohaData.error);
              
              ownedIsbns = kohaData.isbns;
              appendLog("<span style='color: #2ecc71;'>[SYSTEM] Successfully loaded " + ownedIsbns.length + " ISBNs from Koha.</span>");
              
              processNextBook();

          } catch(err) {
              status.innerText = "Failed to start: " + err.message;
              status.style.color = "#e74c3c";
          }
        }

        async function processNextBook() {
            const status = document.getElementById('status');
            const resultsContainer = document.getElementById('results-container');

            if (currentIndex >= ownedIsbns.length) {
                status.innerText = "Analysis Complete! Checked " + ownedIsbns.length + " items.";
                status.style.color = "#27ae60";
                appendLog("<span style='color: #2ecc71;'>[SYSTEM] Scan successfully completed.</span>");
                return;
            }

            const currentIsbn = ownedIsbns[currentIndex];
            const percent = Math.min(100, Math.round((currentIndex / ownedIsbns.length) * 100));
            document.getElementById('progress-bar').style.width = percent + '%';
            status.innerText = "Analyzing item " + (currentIndex + 1) + " of " + ownedIsbns.length + "...";

            try {
                // Throttle: Open Library needs a slower pace to prevent 503 errors
                await sleep(1500);

                const olRes = await fetch(\`https://openlibrary.org/search.json?q=isbn:\${currentIsbn}\`);
                
                if (!olRes.ok) throw new Error("Open Library API Error: " + olRes.status);
                
                const olData = await olRes.json();

                if (!olData.docs || olData.docs.length === 0) {
                    appendLog(\`[SKIP] ISBN \${currentIsbn}: Not found in Open Library.\`);
                } else {
                    const bookDoc = olData.docs[0];
                    const author = bookDoc.author_name ? bookDoc.author_name[0] : "Unknown Author";
                    const seriesList = bookDoc.series || [];

                    if (seriesList.length === 0) {
                        appendLog(\`[SKIP] ISBN \${currentIsbn}: No series tag found.\`);
                    } else {
                        const seriesName = seriesList[0];

                        // Memory Check: Have we already processed this exact series?
                        if (analyzedSeriesCache.has(seriesName)) {
                            appendLog(\`[MEMORY] Skipping \${currentIsbn}: '\${seriesName}' already analyzed.\`);
                        } else {
                            // Mark series as analyzed
                            analyzedSeriesCache.add(seriesName);
                            appendLog(\`[SEARCHING] Found new series: '\${seriesName}'. Checking full catalog...\`);

                            await sleep(1500); 
                            const authorRes = await fetch(\`https://openlibrary.org/search.json?author="\${encodeURIComponent(author)}"&limit=150\`);
                            const authorData = await authorRes.json();
                            
                            // Filter down to ONLY books in this exact series
                            const seriesBooks = (authorData.docs || []).filter(b => b.series && b.series.includes(seriesName));

                            let missingCount = 0;
                            for (const book of seriesBooks) {
                                const cleanBookIsbns = (book.isbn || []).map(id => id.replace(/-/g, '').trim());
                                const isOwned = cleanBookIsbns.some(isbn => ownedIsbns.includes(isbn));

                                if (!isOwned && book.title) {
                                    // --- ACCORDION UI LOGIC ---
                                    const safeSeriesId = "group-" + seriesName.replace(/[^a-zA-Z0-9]/g, "");
                                    let groupBtn = document.getElementById("btn-" + safeSeriesId);
                                    let groupPanel = document.getElementById("panel-" + safeSeriesId);

                                    if (!groupBtn) {
                                        groupBtn = document.createElement("button");
                                        groupBtn.id = "btn-" + safeSeriesId;
                                        groupBtn.className = "accordion";
                                        groupBtn.dataset.count = 0; 
                                        
                                        groupBtn.onclick = function() {
                                            this.classList.toggle("active");
                                            let panel = this.nextElementSibling;
                                            panel.style.display = panel.style.display === "block" ? "none" : "block";
                                        };

                                        groupPanel = document.createElement("div");
                                        groupPanel.id = "panel-" + safeSeriesId;
                                        groupPanel.className = "panel";
                                        groupPanel.innerHTML = \`<table><thead><tr><th>Missing Title</th><th>Author</th><th>Year</th><th>ISBN</th></tr></thead><tbody></tbody></table>\`;
                                        
                                        resultsContainer.appendChild(groupBtn);
                                        resultsContainer.appendChild(groupPanel);
                                    }

                                    let currentCount = parseInt(groupBtn.dataset.count) + 1;
                                    groupBtn.dataset.count = currentCount;
                                    groupBtn.innerHTML = \`<span>\${seriesName}</span> <span>\${currentCount} Missing Volumes ▾</span>\`;

                                    const tbody = groupPanel.querySelector("tbody");
                                    const row = tbody.insertRow();
                                    const displayIsbn = cleanBookIsbns.length > 0 ? cleanBookIsbns[0] : "N/A";
                                    row.innerHTML = \`<td>\${book.title}</td><td>\${author}</td><td>\${book.first_publish_year || "??"}</td><td>\${displayIsbn}</td>\`;
                                    missingCount++;
                                }
                            }
                            appendLog(\`[SUCCESS] Analyzed '\${seriesName}': Found \${missingCount} missing titles.\`);
                        }
                    }
                }
                
                currentIndex++;
                processNextBook();

            } catch (err) {
                if(err.message.includes("502") || err.message.includes("503") || err.message.includes("504")) {
                    appendLog("<span style='color: #e67e22;'>[WARNING] Open Library Server Overload. Sleeping 10 seconds...</span>");
                    await sleep(10000);
                    processNextBook(); // Retry
                } else {
                    appendLog("<span style='color: #e74c3c;'>[ERROR] " + err.message + " Skipping.</span>");
                    currentIndex++;
                    processNextBook();
                }
            }
        }
      </script>
    </body>
    </html>
  `;

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(htmlOutput);
}
