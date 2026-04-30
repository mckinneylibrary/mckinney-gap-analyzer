export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 
  
  try {
    const kohaResponse = await fetch(KOHA_JSON_URL);
    
    if (!kohaResponse.ok) {
        return res.status(500).json({ error: `Failed to reach Koha. Status: ${kohaResponse.status}` });
    }

    const kohaData = await kohaResponse.json();
    
    // --- THE FIX: Parse Koha's specific Array of Arrays format ---
    let ownedIsbns = [];
    
    if (kohaData.length > 1 && Array.isArray(kohaData[0])) {
      // It's a Koha array. Skip the first row (headers) and grab the first column
      ownedIsbns = kohaData.slice(1).map(row => {
          const isbnStr = row[0] ? String(row[0]) : '';
          return isbnStr.replace(/-/g, '').trim();
      }).filter(isbn => isbn !== ''); // Remove any blanks
    }

    if (!ownedIsbns.length) {
      return res.status(200).json({ 
          message: "Could not parse ISBNs from Koha.", 
          raw_data_preview: kohaData.slice(0, 2), // Shows what it saw for debugging
          url_checked: KOHA_JSON_URL 
      });
    }

    // Process the first ISBN as a test case
    const testIsbn = ownedIsbns[0];
    const googleBookRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${testIsbn}`);
    const googleBookData = await googleBookRes.json();

    if (!googleBookData.items || googleBookData.items.length === 0) {
      return res.status(404).json({ 
          error: "Initial test book not found in Google Books API.",
          test_isbn: testIsbn
      });
    }

    const bookInfo = googleBookData.items[0].volumeInfo;
    const author = bookInfo.authors ? bookInfo.authors[0] : "";
    
    if (!author) {
        return res.status(404).json({ error: "No author found for the test ISBN." });
    }

    // Search Google Books for other titles by this author
    const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=40`);
    const seriesData = await seriesRes.json();

    const missingBooks = [];
    const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

    // Compare API results against the Koha Owned List
    for (const book of seriesTitles) {
      const bookIsbns = book.industryIdentifiers 
        ? book.industryIdentifiers.map(id => id.identifier) 
        : [];
      
      const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

      if (!isOwned && book.title) {
        missingBooks.push({
          title: book.title,
          publishedDate: book.publishedDate || "Unknown",
          isbns: bookIsbns
        });
      }
    }

    return res.status(200).json({
      analyzed_collection: collectionCode,
      analyzed_author: author,
      owned_count: ownedIsbns.length,
      missing_volumes_found: missingBooks.length,
      missing_books: missingBooks
    });

  } catch (error) {
    console.error("Analysis Error:", error);
    return res.status(500).json({ 
        error: "An error occurred during the gap analysis.",
        details: error.message
    });
  }
}
