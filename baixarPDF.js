const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteerExtra.use(StealthPlugin());

async function extractProcessDetails(page) {
    return await page.evaluate(() => {
        const extractTableData = (tableId) => {
            const table = document.getElementById(tableId);
            if (!table) return [];

            return Array.from(table.querySelectorAll('tr')).map(row => {
                const cells = row.querySelectorAll('td');
                return cells.length > 1 
                    ? {
                        label: cells[0].textContent.trim(),
                        value: cells[1].textContent.trim()
                    }
                    : null;
            }).filter(item => item !== null);
        };

        const extractHistoryData = () => {
            const historyTable = document.getElementById('tblHistorico');
            if (!historyTable) return [];

            return Array.from(historyTable.querySelectorAll('tr.andamentoConcluido')).map(row => {
                const cells = row.querySelectorAll('td');
                return cells.length === 3 ? {
                    dateTime: cells[0].textContent.trim(),
                    unit: cells[1].textContent.trim(),
                    description: cells[2].textContent.trim()
                } : null;
            }).filter(item => item !== null);
        };

        const extractDocuments = () => {
            const documentsTable = document.getElementById('tblDocumentos');
            if (!documentsTable) return [];
        
            // Ignorar a primeira linha (cabeçalho)
            return Array.from(documentsTable.querySelectorAll('tr'))
                .slice(1) // Ignorar o cabeçalho
                .map(row => {
                    const cells = row.querySelectorAll('td');
        
                    // Certifique-se de que há células suficientes antes de acessá-las
                    if (cells.length >= 6) {
                        const linkElement = cells[1].querySelector('a');
                        return {
                            documentNumber: cells[1]?.textContent.trim() || '',
                            documentType: cells[2]?.textContent.trim() || '',
                            documentDate: cells[3]?.textContent.trim() || '',
                            registrationDate: cells[4]?.textContent.trim() || '',
                            unit: cells[5]?.textContent.trim() || '',
                            link: linkElement
                                ? linkElement.getAttribute('onclick').match(/window\.open\('(.*?)'\)/)?.[1]
                                : null,
                        };
                    }
        
                    return null; // Ignorar linhas incompletas
                })
                .filter(item => item !== null); // Filtrar resultados válidos
        };
        
        
        

        return {
            headerDetails: extractTableData('tblCabecalho'),
            processHistory: extractHistoryData(),
            documentList: extractDocuments(),
        };
    });
}

async function processLinks() {
    const links = JSON.parse(fs.readFileSync('./resultados.json', 'utf-8'));
    
    const browser = await puppeteerExtra.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const outputFilePath = 'processed_documents.json';
    let processedDocuments = [];

    // Verifica se o arquivo já existe para carregar progresso anterior
    if (fs.existsSync(outputFilePath)) {
        processedDocuments = JSON.parse(fs.readFileSync(outputFilePath, 'utf-8'));
        console.log(`Resuming from ${processedDocuments.length} processed documents.`);
    }

    try {
        for (const doc of links) {
            // Ignora documentos já processados
            if (processedDocuments.some(d => d.processNumber === doc.title)) {
                console.log(`Skipping already processed document: ${doc.title}`);
                continue;
            }

            const page = await browser.newPage();
            try {
                await page.goto(doc.link, { 
                    waitUntil: 'networkidle2', 
                    timeout: 60000 
                });

                const details = await extractProcessDetails(page);

                const processedDocument = {
                    processNumber: doc.title,
                    link: doc.link,
                    ...details
                };

                processedDocuments.push(processedDocument);

                // Salva o progresso atual
                fs.writeFileSync(outputFilePath, JSON.stringify(processedDocuments, null, 2));
                console.log(`Saved progress for ${doc.title}`);

                await page.close();
            } catch (pageError) {
                console.error(`Error processing ${doc.title}:`, pageError);
                await page.close();
            }
        }
    } catch (error) {
        console.error('Overall processing error:', error);
    } finally {
        await browser.close();
    }

    console.log(`Finished processing ${processedDocuments.length} documents.`);
    return processedDocuments;
}


processLinks()
    .then(results => console.log('Extraction complete'))
    .catch(console.error);
