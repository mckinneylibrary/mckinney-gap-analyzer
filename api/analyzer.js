export default async function handler(req, res) {
  // Grab the collection code from the Vercel URL (defaults to YA if none provided)
  const collectionCode = req.query.ccode || 'YA'; 
  
  // Your specific McKinney Koha report URL, appending the required SQL parameter
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 
  
  try {
    // 1. Fetch the owned ISBNs from the Koha report
    const kohaResponse = await fetch(KOHA_JSON_URL);
    
    if (!kohaResponse.ok) {
        return res.status(500).json({ error: `Failed to reach Koha. Status: ${kohaResponse.status}` });
    }

    const kohaData = await kohaResponse.json();
    
    // Clean the ISBNs (remove dashes and whitespace)
    const ownedIsbns = kohaData
        .filter(row => row.isbn) // Ensure the row has an ISBN field
        .map(row => row.isbn.replace(/-/g, '').trim());

    if (!ownedIsbns.length) {
      return res.status(200).json({ 
          message: "No ISBNs found in Koha report.", 
          url_checked: KOHA_JSON_URL 
      });
    }

    // 2. Process the first ISBN as a test case to establish the author/series
    // (In a full production run, you would iterate through the ownedIsbns array)
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

    // 3. Search Google Books for other titles by this author (proxy for series completion)
    const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=40`);
    const seriesData = await seriesRes.json();

    const missingBooks = [];
    const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

    // 4. The Gap Analysis: Compare API results against the Koha Owned List
    for (const book of seriesTitles) {
      const bookIsbns = book.industryIdentifiers 
        ? book.industryIdentifiers.map(id => id.identifier) 
        : [];
      
      // Check if any of the Google Books ISBNs match our Koha ISBNs
      const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

      if (!isOwned && book.title) {
        missingBooks.push({
          title: book.title,
          publishedDate: book.publishedDate || "Unknown",
          isbns: bookIsbns
        });
      }
    }

    // 5. Return the final JSON payload
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
