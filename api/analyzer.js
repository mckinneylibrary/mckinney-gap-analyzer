export default async function handler(req, res) {
  const collectionCode = req.query.ccode || 'YA'; 
  const offset = parseInt(req.query.offset) || 0; 
  const batchSize = 3; 
  
  const KOHA_JSON_URL = `https://mckinney.bywatersolutions.com/cgi-bin/koha/svc/report?id=1166&sql_params=${collectionCode}`; 

  // --- 1. THE BACKEND DATA PROCESSOR ---
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
      const logs = []; 

      for (const currentIsbn of batchToProcess) {
          await new Promise(resolve => setTimeout(resolve, 1000));

          const googleBookRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${currentIsbn}`);
          const googleBookData = await googleBookRes.json();

          if (!googleBookData.items || googleBookData.items.length === 0) continue;

          const author = googleBookData.items[0].volumeInfo.authors ? googleBookData.items[0].volumeInfo.authors[0] : "";
          if (!author) continue;

          const seriesRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=40`);
          const seriesData = await seriesRes.json();
          const seriesTitles = seriesData.items ? seriesData.items.map(item => item.volumeInfo) : [];

          let missingCount = 0;
          for (const book of seriesTitles) {
              const bookIsbns = book.industryIdentifiers 
                  ? book.industryIdentifiers.map(id => id.identifier) 
                  : [];
              
              const isOwned = bookIsbns.some(isbn => ownedIsbns.includes(isbn));

              if (!isOwned && book.title) {
                  // --- THE HACK: Title Regex Extraction ---
                  let extractedSeries = `Other works by ${author}`; // Default fallback
                  
                  // Look for text inside parentheses
                  const parensMatch = book.title.match(/\((.*?)\)/);
                  if (parensMatch) {
                      // Strip out "Book 1", "Vol. 2", "#3", etc.
                      let cleanedText = parensMatch[1].replace(/,?\s*(Book|Vol\.?|Volume|#|No\.?|Bk\.?)\s*\d+/i, '').trim();
                      if (cleanedText.length > 2) {
                          extractedSeries = cleanedText;
                      }
                  }

                  results.push({
                      series: extractedSeries,
                      author: author,
                      title: book.title,
                      year: book.publishedDate ? book.publishedDate.substring(0,4) : "??",
                      isbns: bookIsbns.slice(0, 1).map(id => id.identifier).join('')
                  });
                  missingCount++;
              }
          }
          if(missingCount > 0) logs.push(`[SUCCESS] Analyzed ${author}: Found ${missingCount} missing titles.`);
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
        body { font-family:
