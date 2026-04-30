export default async function handler(req, res) {
  // 1. Define your data sources
  // Replace this with the actual URL of your public JSON report from Koha
  const KOHA_JSON_URL = "https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166"; 
  
  try {
    // 2. Fetch the owned ISBNs from Koha
    const kohaResponse = await fetch(KOHA_JSON_URL);
    const kohaData = await kohaResponse.json();
    
    // Assuming your Koha report outputs an array of objects with an "isbn" key
    const ownedIsbns = kohaData.map(row => row.isbn.replace(/-/g, '').trim());

    if (!ownedIsbns.length) {
      return res.status(200).json({ message: "No ISBNs found in Koha report." });
    }

    // 3. Process the first ISBN as a test case for the series
    // Note: In a full production script, you would loop through all ISBNs. 
    // We are checking one here to respect API limits during setup.
    const testIsbn = ownedIsbns[0];
    const googleBookRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${testIsbn}`);
    const googleBookData = await googleBookRes.json();

    if (!googleBookData.items || googleBookData.items.length === 0) {
      return res.status(404).json({ error: "Book not found in Google Books API." });
    }

    const bookInfo = googleBookData.items[0].volumeInfo;
    const author = bookInfo.authors ? bookInfo.authors[0] : "";
    
    // 4. Search Google Books for other titles by this author (proxy for series search)
    // Google Books API does not have a strict "Series" endpoint, so searching by Author + Keywords is the most reliable method.
    const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=40`);
    const seriesData = await seriesRes.json();

    const missingBooks = [];
    const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

    // 5. The Gap Analysis: Compare API results against Koha Owned List
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

    // 6. Return the missing books as a clean JSON response
    return res.status(200).json({
      analyzed_author: author,
      owned_count: ownedIsbns.length,
      missing_volumes_found: missingBooks.length,
      missing_books: missingBooks
    });

  } catch (error) {
    console.error("Analysis Error:", error);
    return res.status(500).json({ error: "An error occurred during the gap analysis." });
  }
}
