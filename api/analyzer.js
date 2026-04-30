export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 
  
  try {
    const kohaResponse = await fetch(KOHA_JSON_URL);
    if (!kohaResponse.ok) return res.status(500).json({ error: `Failed to reach Koha.` });

    const kohaData = await kohaResponse.json();
    
    let ownedIsbns = [];
    if (kohaData.length > 1 && Array.isArray(kohaData[0])) {
      ownedIsbns = kohaData.slice(1).map(row => {
          const isbnStr = row[0] ? String(row[0]) : '';
          return isbnStr.replace(/-/g, '').trim();
      }).filter(isbn => isbn !== '');
    }

    if (!ownedIsbns.length) {
      return res.status(200).send("<h1>No ISBNs found in Koha report. Check the collection code.</h1>");
    }

    // Process a safe batch of 10 books to stay under Vercel's 10-second timeout limit
    const batchToProcess = ownedIsbns.slice(0, 10); 
    
    const missingBooksMaster = [];
    const analyzedSeries = new Set(); 
    let standaloneBooksSkipped = 0;

    for (const currentIsbn of batchToProcess) {
        // 1. Look up the book in the Open Library Database
        const olRes = await fetch(`https://openlibrary.org/search.json?q=isbn:${currentIsbn}`);
        const olData = await olRes.json();

        if (!olData.docs || olData.docs.length === 0) continue;

        const bookDoc = olData.docs[0];
        const author = bookDoc.author_name ? bookDoc.author_name[0] : "";
        const seriesList = bookDoc.series || [];

        // 2. The Filter: If this book doesn't belong to a series, skip it entirely
        if (!author || seriesList.length === 0) {
            standaloneBooksSkipped++;
            continue; 
        }

        const seriesName = seriesList[0];
        
        // If we've already run a gap analysis on this series, skip to the next ISBN
        if (analyzedSeries.has(seriesName)) continue;
        analyzedSeries.add(seriesName);

        // 3. Fetch the Author's full catalog from Open Library
        const authorRes = await fetch(`https://openlibrary.org/search.json?author="${encodeURIComponent(author)}"&limit=150`);
        const authorData = await authorRes.json();
        const allAuthorBooks = authorData.docs || [];

        // 4. Strict Series Match: Filter the catalog down to ONLY books in this exact series
        const seriesBooks = allAuthorBooks.filter(book => {
            return book.series && book.series.includes(seriesName);
        });

        // 5. Gap Analysis
        for (const book of seriesBooks) {
            const bookIsbns = book.isbn || [];
            // Clean Open Library ISBNs (remove dashes/spaces)
            const cleanBookIsbns = bookIsbns.map(id => id.replace(/-/g, '').trim());
            
            const isOwned = cleanBookIsbns.some(isbn => ownedIsbns.includes(isbn));

            if (!isOwned && book.title) {
                missingBooksMaster.push({
                    series: seriesName,
                    author: author,
                    title: book.title,
                    publishedDate: book.first_publish_year || "Unknown",
                    isbns: cleanBookIsbns.slice(0, 2).join(', ') // Only show 2 ISBNs to keep the table tidy
                });
            }
        }
    }

    // --- HTML Formatting ---
    const tableRows = missingBooksMaster.map(book => `
      <tr>
        <td><strong>${book.series}</strong></td>
        <td>${book.title}</td>
        <td>${book.author}</td>
        <td>${book.publishedDate}</td>
        <td>${book.isbns}</td>
      </tr>
    `).join('');

    const htmlOutput = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Collection Gap Analysis</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 1100px; margin: 0 auto; padding: 2rem; background-color: #f9fafb; }
          .header-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); margin-bottom: 20px; }
          h1 { margin-top: 0; color: #111; }
          .stats { display: flex; gap: 20px; font-size: 1.1rem; flex-wrap: wrap; }
          .stat-box { background: #eff6ff; padding: 10px 20px; border-radius: 6px; border-left: 4px solid #3b82f6; margin-bottom: 10px; }
          table { width: 100%; background: white; border-collapse: collapse; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border-radius: 8px; overflow: hidden; }
          th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #e5e7eb; }
          th { background-color: #f3f4f6; font-weight: 600; color: #4b5563; }
          tr:hover { background-color: #f9fafb; }
        </style>
      </head>
      <body>
        <div class="header-card">
          <h1>Series Gap Analysis</h1>
          <div class="stats">
            <div class="stat-box"><strong>Collection Code:</strong> ${collectionCode}</div>
            <div class="stat-box"><strong>Total Library Titles Checked:</strong> ${batchToProcess.length}</div>
            <div class="stat-box"><strong>Series Identified:</strong> ${Array.from(analyzedSeries).join(', ') || 'None found in this batch'}</div>
            <div class="stat-box"><strong>Standalone Books Skipped:</strong> ${standaloneBooksSkipped}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Series Name</th>
              <th>Missing Title</th>
              <th>Author</th>
              <th>Publication Date</th>
              <th>ISBNs (Open Library)</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || '<tr><td colspan="5" style="text-align:center;">No missing series volumes found in this batch! Refresh to check more.</td></tr>'}
          </tbody>
        </table>
      </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlOutput);

  } catch (error) {
    console.error("Analysis Error:", error);
    return res.status(500).send(`<h1>An error occurred: ${error.message}</h1>`);
  }
}
