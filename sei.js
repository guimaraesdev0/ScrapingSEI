const express = require('express');
const puppeteer = require('puppeteer');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
const PORT = 8762;

app.use(express.json());

async function waitForStableNavigation(page, timeout = 30000) {
    try {
        await page.waitForNavigation({ 
            waitUntil: 'networkidle0',
            timeout: timeout
        });
    } catch (error) {
        console.log('Navigation timeout, checking if page is stable...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

async function processCaptcha(page, processNumber) {
    try {
        const captchaImage = await page.$('img[alt="Não foi possível carregar imagem de confirmação"]');
        if (!captchaImage) {
            throw new Error('Captcha image not found');
        }

        const captchaSrc = await captchaImage.evaluate(img => img.src);
        const captchaBuffer = await page.evaluate(async (src) => {
            const response = await fetch(src);
            const buffer = await response.arrayBuffer();
            return Array.from(new Uint8Array(buffer));
        }, captchaSrc);

        // Use process number in filename to avoid conflicts
        const captchaPath = `captcha-${processNumber.replace(/[/.]/g, '-')}.png`;
        const processedPath = `captcha-processed-${processNumber.replace(/[/.]/g, '-')}.png`;

        fs.writeFileSync(captchaPath, Buffer.from(captchaBuffer));

        await sharp(captchaPath)
            .greyscale()
            .threshold(145)
            .toFile(processedPath);

        const ocrResult = await tesseract.recognize(processedPath, 'eng');

        // Cleanup
        fs.unlinkSync(captchaPath);
        fs.unlinkSync(processedPath);

        return ocrResult.data.text.replace(/\s/g, '').trim();
    } catch (error) {
        console.error(`Error processing captcha for process ${processNumber}:`, error);
        throw error;
    }
}

async function runSingleProcess(processNumber, maxRetries = 100) {
    let browser = null;
    let page = null;
    let retryCount = 0;

    try {
        // Criar uma nova instância do navegador para cada processo
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security'
            ]
        });

        page = await browser.newPage();
        
        page.on('dialog', async dialog => {
            console.log(`Dialog message for process ${processNumber}: ${dialog.message()}`);
            await dialog.dismiss();
        });

        while (retryCount < maxRetries) {
            try {
                console.log(`Attempting process ${processNumber} - Try ${retryCount + 1}`);
                
                await page.goto('https://sei.anm.gov.br/sei/modulos/pesquisa/md_pesq_processo_pesquisar.php?acao_externa=protocolo_pesquisar&acao_origem_externa=protocolo_pesquisar&id_orgao_acesso_externo=0', {
                    waitUntil: 'networkidle0',
                    timeout: 30000
                });

                await page.waitForSelector('#txtProtocoloPesquisa', { visible: true });
                await page.waitForSelector('#txtCaptcha', { visible: true });

                await page.$eval('#txtProtocoloPesquisa', (el, value) => el.value = value, processNumber);

                let captchaSuccess = false;
                let captchaRetries = 0;
                
                while (!captchaSuccess && captchaRetries < 3) {
                    try {
                        console.log(`Attempting captcha for process ${processNumber} - Try ${captchaRetries + 1}`);
                        
                        const captchaText = await processCaptcha(page, processNumber);
                        await page.$eval('#txtCaptcha', (el, value) => el.value = value, captchaText);
                        
                        await Promise.all([
                            page.click('#sbmPesquisar'),
                            waitForStableNavigation(page)
                        ]);

                        const resultsExist = await page.evaluate(() => {
                            return !!document.querySelector('.infraAreaTabela .resultado tbody tr.resTituloRegistro');
                        });

                        if (resultsExist) {
                            captchaSuccess = true;
                        } else {
                            captchaRetries++;
                            if (captchaRetries < 3) {
                                await page.reload({ waitUntil: 'networkidle0' });
                            }
                        }
                    } catch (error) {
                        console.error(`Captcha attempt ${captchaRetries + 1} failed for process ${processNumber}:`, error);
                        captchaRetries++;
                        if (captchaRetries < 3) {
                            await page.reload({ waitUntil: 'networkidle0' });
                        }
                    }
                }

                if (!captchaSuccess) {
                    throw new Error('Failed to solve captcha after multiple attempts');
                }

                const results = await page.$$eval('.infraAreaTabela .resultado tbody tr.resTituloRegistro', rows => {
                    return rows.map(row => {
                        const title = row.querySelector('.resTituloEsquerda a.protocoloNormal')?.textContent.trim();
                        const link = row.querySelector('.resTituloEsquerda a.protocoloNormal')?.href;
                        return { title, link };
                    });
                });

                return {
                    DSProcesso: processNumber,
                    results: results.length > 0 ? results : [],
                    status: results.length > 0 ? 'success' : 'no_results'
                };

            } catch (error) {
                retryCount++;
                console.error(`Attempt ${retryCount} failed for process ${processNumber}:`, error);
                
                if (retryCount >= maxRetries) {
                    return {
                        DSProcesso: processNumber,
                        error: `Failed after ${maxRetries} attempts: ${error.message}`,
                        status: 'error'
                    };
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function processAllInParallel(processNumbers, maxConcurrent = 10) {
    // Processa em lotes para controlar o número máximo de navegadores simultâneos
    const results = [];
    for (let i = 0; i < processNumbers.length; i += maxConcurrent) {
        const batch = processNumbers.slice(i, i + maxConcurrent);
        console.log(`Processing batch ${i/maxConcurrent + 1}, processes: ${batch.join(', ')}`);
        
        // Executa cada processo do lote em paralelo
        const batchResults = await Promise.all(
            batch.map(processNumber => runSingleProcess(processNumber))
        );
        results.push(...batchResults);
    }
    return results;
}

app.post('/buscar', async (req, res) => {
    const { DSProcesso } = req.body;
    
    if (!DSProcesso || !Array.isArray(DSProcesso) || DSProcesso.length === 0) {
        return res.status(400).json({ 
            error: 'DSProcesso deve ser um array não vazio de números de processo' 
        });
    }
    
    try {
        const results = await processAllInParallel(DSProcesso);
        res.json({
            DSProcesso: results
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Erro ao processar os requests', 
            details: error.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`API rodando na porta ${PORT}`);
});
