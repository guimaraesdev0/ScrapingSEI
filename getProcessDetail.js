const puppeteerExtra = require('puppeteer-extra');
const fs = require('fs');
const path = require('path');
const colors = require('colors');  // Usando colors para estilizar o console

async function loadResults(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        console.log('Lista de links carregados com sucesso');
        return JSON.parse(data);
    } catch (error) {
        console.error('Erro ao carregar o arquivo JSON:'.red, error);
        return [];
    }
}

async function downloadPDFs(url) {

}


async function processAllLinks(filePath) {
    const results = await loadResults(filePath);

    for (const result of results) {
        await downloadPDFs(result.link);
    }
}

processAllLinks('./resultados.json').catch(console.error);
