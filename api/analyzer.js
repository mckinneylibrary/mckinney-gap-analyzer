export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 

  // --- 1. THE BACKEND: Only fetches Koha Data now (Lightning Fast) ---
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

      // Send the entire list to the browser at once
      return res.status(200).json({ isbns: ownedIsbns });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // --- 2. THE FRONTEND: The Browser does the heavy lifting ---
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
        
        .dashboard-grid { display: flex; gap: 30px; margin-top: 20px; align-items: flex-start;}
        .results-section { flex: 2; display: flex; flex-direction: column; gap: 10px; }
        .log-section { flex: 1; background: #1e272e; color: #00d2d3; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 13px; height: 600px; overflow-y: auto; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);}
        
        .accordion { background-color: #f8f9fa; color: #2c3e50; cursor: pointer; padding: 15px; width: 100%; border: 1px solid #e0e0e0; text-align: left; outline: none; font-size: 16px; font-weight: bold; border-radius: 6px; transition: 0.3s; display: flex; justify-content: space-between; align-items: center;}
        .accordion:hover { background-color: #e9ecef; }
        .accordion.active { background-color: #3498db; color: white; border-color: #3498db; border-bottom-left-radius: 0; border-bottom-right-radius: 0;}
        .panel { padding: 0; background-color: white; display: none; overflow: hidden; border: 1px solid #e0e0e0; border-top: none; border-bottom-left-radius: 6px; border-bottom-right-radius: 6px; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px 15px; border-bottom: 1px solid #eee; }
        th { background: #fbfcfc; font-size: 14px; color: #7f8c8d;}
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Author Gap Analyzer (Client-Side Mode)</h1>
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
        
        // A helper function to force the browser to pause and respect rate limits
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
              // 1. Fetch the master list of ISBNs from Koha via Vercel
              status.innerText = "Fetching master ISBN list from Koha...";
              const kohaRes = await fetch(\`/api/analyzer?mode=koha&ccode=\${ccode}\`);
              const kohaData = await kohaRes.json();
              
              if(kohaData.error) throw new Error(kohaData.error);
              
              ownedIsbns = kohaData.isbns;
              appendLog("<span style='color: #2ecc71;'>[SYSTEM] Successfully loaded " + ownedIsbns.length + " ISBNs from Koha.</span>");
              
              // 2. Start the browser loop
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

            // Update Progress UI
            const percent = Math.min(100, Math.round((currentIndex / ownedIsbns.length) * 100));
            document.getElementById('progress-bar').style.width = percent + '%';
            status.innerText = "Analyzing item " + (currentIndex + 1) + " of " + ownedIsbns.length + "...";

            try {
                // Throttle: 1.5 seconds per book. This bypasses the Google 429 error!
                await sleep(1500);

                // Fetch Google Books ISBN
                const googleBookRes = await fetch(\`https://www.googleapis.com/books/v1/volumes?q=isbn:\${currentIsbn}\`);
                
                if (googleBookRes.status === 429) {
                    throw new Error("Google Rate Limit Hit. Cooling down...");
                }
                
                const googleBookData = await googleBookRes.json();

                if (!googleBookData.items || googleBookData.items.length === 0) {
                    appendLog(\`[SKIP] ISBN \${currentIsbn}: Not found in Google database.\`);
                } else {
                    const author = googleBookData.items[0].volumeInfo.authors ? googleBookData.items[0].volumeInfo.authors[0] : "";
                    
                    if (!author) {
                        appendLog(\`[SKIP] ISBN \${currentIsbn}: No author listed.\`);
                    } else {
                        // Fetch Author Series
                        await sleep(1000); // Small pause before second Google request
                        const seriesRes = await fetch(\`https://www.googleapis.com/books/v1/volumes?q=inauthor:"\${author}"&maxResults=35\`);
                        const seriesData = await seriesRes.json();
                        const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

                        let missingCount = 0;
                        for (const book of seriesTitles) {
                            const bookIsbns = book.industryIdentifiers ? book.industryIdentifiers.map(id => id.identifier) : [];
                            
                            // Check against the master array we pulled at the very beginning
                            const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

                            if (!isOwned && book.title) {
                                // --- ACCORDION UI LOGIC ---
                                const safeAuthorId = "group-" + author.replace(/[^a-zA-Z0-9]/g, "");
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
                                        panel.style.display = panel.style.display === "block" ? "none" : "block";
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
                                groupBtn.innerHTML = \`<span>\${author}</span> <span>\${currentCount} Missing Volumes ▾</span>\`;

                                const tbody = groupPanel.querySelector("tbody");
                                const row = tbody.insertRow();
                                const displayIsbn = bookIsbns.slice(0, 1).join('');
                                row.innerHTML = \`<td>\${book.title}</td><td>\${book.publishedDate || "??"}</td><td>\${displayIsbn}</td>\`;
                                missingCount++;
                            }
                        }
                        appendLog(\`[SUCCESS] Analyzed \${author}: Found \${missingCount} missing titles.\`);
                    }
                }
                
                // Move to next book
                currentIndex++;
                processNextBook();

            } catch (err) {
                // If we get a 429, wait 10 seconds and try the exact same book again!
                if(err.message.includes("Rate Limit")) {
                    appendLog("<span style='color: #e67e22;'>[WARNING] Google Rate Limit. Sleeping 10 seconds...</span>");
                    await sleep(10000);
                    processNextBook(); // Retry without advancing currentIndex
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
