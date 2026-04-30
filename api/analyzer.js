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

    // --- THE UPGRADE: Batch Processing ---
    // We will check the first 5 ISBNs to stay under Vercel's 10-second timeout.
    // You can cautiously increase this number, but if you hit a 504 error, lower it back down.
    const batchToProcess = ownedIsbns.slice(0, 5); 
    
    const missingBooksMaster = [];
    const analyzedAuthors = new Set(); // Keeps track of authors we've already checked so we don't repeat work

    for (const currentIsbn of batchToProcess) {
        // 1. Identify the Author
        const googleBookRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${currentIsbn}`);
        const googleBookData = await googleBookRes.json();

        if (!googleBookData.items || googleBookData.items.length === 0) continue; // Skip if book not found

        const author = googleBookData.items[0].volumeInfo.authors ? googleBookData.items[0].volumeInfo.authors[0] : "";
        
        // If we have no author, or we've already analyzed this author, skip to the next ISBN
        if (!author || analyzedAuthors.has(author)) continue;
        
        analyzedAuthors.add(author);

        // 2. Search for the Author's complete works
        const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=40`);
        const seriesData = await seriesRes.json();

        const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

        // 3. Gap Analysis for this specific Author
        for (const book of seriesTitles) {
            const bookIsbns = book.industryIdentifiers 
                ? book.industryIdentifiers.map(id => id.identifier) 
                : [];
            
            const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

            if (!isOwned && book.title) {
                missingBooksMaster.push({
                    author: author,
                    title: book.title,
                    publishedDate: book.publishedDate || "Unknown",
                    isbns: bookIsbns.join(', ')
                });
            }
        }
    }

    // --- HTML Formatting ---
    const tableRows = missingBooksMaster.map(book => `
      <tr>
        <td><strong>${book.author}</strong></td>
        <td>${book.title}</td>
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
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 1000px; margin: 0 auto; padding: 2rem; background-color: #f9fafb; }
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
          <h1>Collection Gap Analysis</h1>
          <div class="stats">
            <div class="stat-box"><strong>Collection Code:</strong> ${collectionCode}</div>
            <div class="stat-box"><strong>Total Library Titles Owned:</strong> ${ownedIsbns.length}</div>
            <div class="stat-box"><strong>Authors Analyzed This Run:</strong> ${Array.from(analyzedAuthors).join(', ')}</div>
            <div class="stat-box"><strong>Missing Volumes Found:</strong> ${missingBooksMaster.length}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Author</th>
              <th>Missing Title</th>
              <th>Publication Date</th>
              <th>ISBNs (Google Books)</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || '<tr><td colspan="4" style="text-align:center;">No missing volumes found for these authors!</td></tr>'}
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
