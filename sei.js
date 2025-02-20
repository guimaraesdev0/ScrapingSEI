const express = require('express');
const puppeteer = require('puppeteer');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());

async function waitForStableNavigation(page, timeout = 30000) {
    try {
        await page.waitForNavigation({ 
            waitUntil: 'networkidle0',
            timeout: timeout
        });
    } catch (error) {
        console.log('Navigation timeout, checking if page is stable...');
        // Wait a bit more to see if the page stabilizes
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

async function processCaptcha(page) {
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

        fs.writeFileSync('captcha.png', Buffer.from(captchaBuffer));

        await sharp('captcha.png')
            .greyscale()
            .threshold(130)
            .toFile('captcha-processed.png');

        const ocrResult = await tesseract.recognize('captcha-processed.png', 'eng');
        return ocrResult.data.text.replace(/\s/g, '').trim();
    } catch (error) {
        console.error('Error processing captcha:', error);
        throw error;
    }
}

async function runAutomation(processNumber, maxRetries = 10) {
    let browser = null;
    let retryCount = 0;

    try {
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security'
            ]
        });

        const page = await browser.newPage();
        
        // Set up dialog handler
        page.on('dialog', async dialog => {
            console.log(`Dialog message: ${dialog.message()}`);
            await dialog.dismiss();
        });

        // Retry loop for the entire process
        while (retryCount < maxRetries) {
            try {
                await page.goto('https://sei.anm.gov.br/sei/modulos/pesquisa/md_pesq_processo_pesquisar.php?acao_externa=protocolo_pesquisar&acao_origem_externa=protocolo_pesquisar&id_orgao_acesso_externo=0', {
                    waitUntil: 'networkidle0',
                    timeout: 30000
                });

                await page.waitForSelector('#txtProtocoloPesquisa', { visible: true });
                await page.waitForSelector('#txtCaptcha', { visible: true });

                // Fill process number
                await page.$eval('#txtProtocoloPesquisa', (el, value) => el.value = value, processNumber);

                // Process captcha
                let captchaSuccess = false;
                let captchaRetries = 0;
                
                while (!captchaSuccess && captchaRetries < 3) {
                    try {
                        const captchaText = await processCaptcha(page);
                        await page.$eval('#txtCaptcha', (el, value) => el.value = value, captchaText);
                        
                        // Click submit and wait for response
                        await Promise.all([
                            page.click('#sbmPesquisar'),
                            waitForStableNavigation(page)
                        ]);

                        // Check if results are present
                        const resultsExist = await page.evaluate(() => {
                            return !!document.querySelector('.infraAreaTabela .resultado tbody tr.resTituloRegistro');
                        });

                        if (resultsExist) {
                            captchaSuccess = true;
                        } else {
                            // If no results, reload page and try again
                            captchaRetries++;
                            if (captchaRetries < 3) {
                                await page.reload({ waitUntil: 'networkidle0' });
                            }
                        }
                    } catch (error) {
                        console.error(`Captcha attempt ${captchaRetries + 1} failed:`, error);
                        captchaRetries++;
                        if (captchaRetries < 3) {
                            await page.reload({ waitUntil: 'networkidle0' });
                        }
                    }
                }

                if (!captchaSuccess) {
                    throw new Error('Failed to solve captcha after multiple attempts');
                }

                // Extract results
                const results = await page.$$eval('.infraAreaTabela .resultado tbody tr.resTituloRegistro', rows => {
                    return rows.map(row => {
                        const title = row.querySelector('.resTituloEsquerda a.protocoloNormal')?.textContent.trim();
                        const link = row.querySelector('.resTituloEsquerda a.protocoloNormal')?.href;
                        return { title, link };
                    });
                });

                if (results.length > 0) {
                    return results[0];
                } else {
                    return { error: 'Nenhum resultado encontrado' };
                }

            } catch (error) {
                retryCount++;
                console.error(`Attempt ${retryCount} failed:`, error);
                
                if (retryCount >= maxRetries) {
                    throw new Error(`Failed after ${maxRetries} attempts: ${error.message}`);
                }
                
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

app.post('/buscar', async (req, res) => {
    const { DSProcesso } = req.body;
    if (!DSProcesso) return res.status(400).json({ error: 'DSProcesso é obrigatório' });
    
    try {
        const data = await runAutomation(DSProcesso);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao processar o request', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`API rodando na porta ${PORT}`);
});