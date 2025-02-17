const sharp = require('sharp');
const puppeteer = require('puppeteer');
const tesseract = require('tesseract.js');
const fs = require('fs');
const csv = require('csv-parser');


async function runAutomation(processNumber) {
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
        ]
    });

    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-UA': '"Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        'Sec-Ch-UA-Mobile': '?0',
        'Sec-Ch-UA-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Referer': 'https://sei.anm.gov.br/sei/modulos/pesquisa/md_pesq_processo_pesquisar.php?acao_externa=protocolo_pesquisar&acao_origem_externa=protocolo_pesquisar&id_orgao_acesso_externo=0',
        'Origin': 'https://sei.anm.gov.br'
    });

    async function processCaptcha() {
        const captchaImage = await page.$('img[alt="Não foi possível carregar imagem de confirmação"]');
        const captchaSrc = await captchaImage.evaluate(img => img.src);
        const captchaUrl = captchaSrc.startsWith('http') ? captchaSrc : `https://sei.anm.gov.br${captchaSrc}`;

        const captchaBuffer = await page.evaluate(async (captchaUrl) => {
            const response = await fetch(captchaUrl);
            const buffer = await response.arrayBuffer();
            return Array.from(new Uint8Array(buffer));
        }, captchaUrl);

        fs.writeFileSync('captcha.png', Buffer.from(captchaBuffer));

        await sharp('captcha.png')
            .greyscale()
            .threshold(130)
            .toFile('captcha-processed.png');

        const ocrResult = await tesseract.recognize('captcha-processed.png', 'eng', {
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            tessedit_pageseg_mode: tesseract.PSM.SINGLE_LINE
        });

        const captchaText = ocrResult.data.text.replace(/\s/g, '').trim();
        console.log(`OCR Result: ${captchaText}`);

        return captchaText;
    }

    async function fillFormAndSubmit() {
        await page.click('#optPeriodoExplicito');
        await page.click('#chkSinDocumentosGerados');
        await page.click('#chkSinDocumentosRecebidos');
        await page.evaluate((processNumber) => {
            document.querySelector('#txtProtocoloPesquisa').value = processNumber;
        }, processNumber);
        const captchaText = await processCaptcha();
        await page.waitForSelector('#txtCaptcha', { visible: true });
        await page.type('#txtCaptcha', captchaText);

        await page.click('#sbmPesquisar');
    }

    page.on('dialog', async dialog => {
        console.log(`Dialog message: ${dialog.message()}`);
        if (dialog.message().includes('Código de confirmação inválido')) {
            await dialog.dismiss();
            console.log('CAPTCHA inválido, tentando novamente...');
            await fillFormAndSubmit();
        } else {
            console.log("captcha completo")
            await dialog.accept();
        }
    });

    await page.goto('https://sei.anm.gov.br/sei/modulos/pesquisa/md_pesq_processo_pesquisar.php?acao_externa=protocolo_pesquisar&acao_origem_externa=protocolo_pesquisar&id_orgao_acesso_externo=0');
    await new Promise(resolve => setTimeout(resolve, 2000));


    await fillFormAndSubmit();

    const allResults = [];
    let isFirstPage = true; // Flag para controlar a página inicial

    // Espera até que a div com os resultados esteja visível para começar a extração
    await page.waitForSelector('#conteudo .resultado', { visible: true });

    while (true) {
        // Espera até que os resultados estejam visíveis (não fixo)
        await page.waitForSelector('.infraAreaTabela .resultado tbody tr.resTituloRegistro', { visible: true });

        const results = await page.$$eval('.infraAreaTabela .resultado tbody tr.resTituloRegistro', rows => {
            return rows.map(row => {
                const title = row.querySelector('.resTituloEsquerda a.protocoloNormal')?.textContent.trim();
                const link = row.querySelector('.resTituloEsquerda a.protocoloNormal')?.href;
                return { title, link };
            });
        });

        console.log(`Resultados encontrados na página atual: ${results.length}`);
        allResults.push(...results);

        // Se não houver resultados, parar a execução e salvar o JSON
        if (results.length === 0) {
            console.log('Nenhum resultado encontrado. Encerrando a execução.');
            fs.writeFileSync('resultados.json', JSON.stringify(allResults, null, 2));
            console.log(`Total de itens extraídos: ${allResults.length}`);
            break; // Encerra o loop
        }

        // Clicar no botão de próxima página
        const nextPageSelector = isFirstPage 
            ? '#conteudo > div.paginas > span > a' // Para a primeira página
            : '#conteudo > div.paginas > span:nth-child(14) > a'; // Para as demais páginas

        const nextPageButton = await page.$(nextPageSelector);
        if (nextPageButton) {
            await Promise.all([
                nextPageButton.click(),
                page.waitForNavigation({ waitUntil: 'networkidle0' }), // Esperar até que a navegação termine
            ]);
            isFirstPage = false; // Atualiza a flag após a primeira navegação
        } else {
            await browser.close();
            console.log('Não há mais páginas. ' + JSON.stringify(allResults));
            return allResults;
        }
    }

    await browser.close(); // Fecha o navegador ao final
}

async function processCSVSequentially() {
    const result = [];
    const rows = [];

    // First, read all rows from the CSV
    await new Promise((resolve, reject) => {
        fs.createReadStream('./processosCSV.csv')
            .pipe(csv())
            .on('data', (row) => rows.push(row))
            .on('end', () => resolve())
            .on('error', (error) => reject(error));
    });

    // Write an initial empty array to the JSON file to prevent JSON errors
    fs.writeFileSync('CSVresultados.json', '[]');  // Start with an empty array

    // Process rows one by one
    for (const row of rows) {
        try {
            const dsprocesso = row.DSProcesso;
            
            // Wait for the automation to complete for each item
            const processoResult = await runAutomation(dsprocesso);

            // Add the result to the array and write it incrementally to the file
            result.push(...processoResult);  // Using spread operator to flatten the results

            // Append the new result to the file
            fs.appendFileSync('CSVresultados.json', JSON.stringify(processoResult[0], null, 4));

            console.log(`Processed: ${dsprocesso[0]}`);

        } catch (error) {
            console.error(`Error processing ${row.DSProcesso}:`, error);
            
            // Optionally, you can decide to continue or break
            // If you want to stop on first error, uncomment the next line
            // break;
        }
    }

    console.log('Processamento concluído e resultados salvos em "CSVresultados.json"');

    return result;
}


processCSVSequentially()
    .then(() => console.log('Finished all processing'))
    .catch(error => console.error('Error in processing:', error));