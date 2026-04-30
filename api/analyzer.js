export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 
  
  try {
    const kohaResponse = await fetch(KOHA_JSON_URL);
    
    if (!kohaResponse.ok) {
        return res.status(500).json({ error: `Failed to reach Koha. Status: ${kohaResponse.status}` });
    }

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

    const testIsbn = ownedIsbns[0];
    const googleBookRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${testIsbn}`);
    const googleBookData = await googleBookRes.json();

    if (!googleBookData.items || googleBookData.items.length === 0) {
      return res.status(404).send(`<h1>Book not found in Google Books API for test ISBN: ${testIsbn}</h1>`);
    }

    const bookInfo = googleBookData.items[0].volumeInfo;
    const author = bookInfo.authors ? bookInfo.authors[0] : "";
    
    if (!author) {
        return res.status(404).send("<h1>No author found for the test ISBN.</h1>");
    }

    const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=40`);
    const seriesData = await seriesRes.json();

    const missingBooks = [];
    const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

    for (const book of seriesTitles) {
      const bookIsbns = book.industryIdentifiers 
        ? book.industryIdentifiers.map(id => id.identifier) 
        : [];
      
      const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

      if (!isOwned && book.title) {
        missingBooks.push({
          title: book.title,
          publishedDate: book.publishedDate || "Unknown",
          isbns: bookIsbns.join(', ')
        });
      }
    }

    // --- NEW: HTML Formatting for Human Readability ---
    
    // Create the table rows from the missingBooks array
    const tableRows = missingBooks.map(book => `
      <tr>
        <td><strong>${book.title}</strong></td>
        <td>${book.publishedDate}</td>
        <td>${book.isbns}</td>
      </tr>
    `).join('');

    // Build the final HTML page
    const htmlOutput = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Collection Gap Analysis</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1000px;
            margin: 0 auto;
            padding: 2rem;
            background-color: #f9fafb;
          }
          .header-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            margin-bottom: 20px;
          }
          h1 { margin-top: 0; color: #111; }
          .stats {
            display: flex;
            gap: 20px;
            font-size: 1.1rem;
          }
          .stat-box {
            background: #eff6ff;
            padding: 10px 20px;
            border-radius: 6px;
            border-left: 4px solid #3b82f6;
          }
          table {
            width: 100%;
            background: white;
            border-collapse: collapse;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            border-radius: 8px;
            overflow: hidden;
          }
          th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #e5e7eb;
          }
          th {
            background-color: #f3f4f6;
            font-weight: 600;
            color: #4b5563;
          }
          tr:hover { background-color: #f9fafb; }
          @media print {
            body { background: white; padding: 0; }
            .header-card { box-shadow: none; border: 1px solid #ddd; }
            table { box-shadow: none; border: 1px solid #ddd; }
          }
        </style>
      </head>
      <body>
        <div class="header-card">
          <h1>Collection Gap Analysis</h1>
          <div class="stats">
            <div class="stat-box"><strong>Collection Code:</strong> ${collectionCode}</div>
            <div class="stat-box"><strong>Analyzed Author:</strong> ${author}</div>
            <div class="stat-box"><strong>Titles Owned:</strong> ${ownedIsbns.length}</div>
            <div class="stat-box"><strong>Missing Volumes:</strong> ${missingBooks.length}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Missing Title</th>
              <th>Publication Date</th>
              <th>ISBNs (Google Books)</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || '<tr><td colspan="3" style="text-align:center;">No missing volumes found!</td></tr>'}
          </tbody>
        </table>
      </body>
      </html>
    `;

    // Tell the browser to render HTML instead of JSON
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlOutput);

  } catch (error) {
    console.error("Analysis Error:", error);
    return res.status(500).send(`<h1>An error occurred: ${error.message}</h1>`);
  }
}
