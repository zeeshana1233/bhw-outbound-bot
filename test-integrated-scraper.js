/**
 * Test the integrated BHW scraper with puppeteer-real-browser
 */

import { BHWScraper } from './src/scraper/index.js';
import logger from './src/utils/logger.js';

async function testIntegratedScraper() {
  const scraper = new BHWScraper();
  
  try {
    logger.info('=== Testing Integrated BHW Scraper ===');
    logger.info('Initializing scraper with puppeteer-real-browser...');
    
    await scraper.initBrowser();
    
    logger.info('Browser initialized! Starting scrape...');
    
    // Run one scrape cycle
    const result = await scraper.scrapeAndStore();
    
    logger.info('Scrape complete!');
    logger.info('Result:', result);
    
    await scraper.closeBrowser();
    
    logger.info('✅ Test complete!');
    
  } catch (error) {
    logger.error('Test failed:', error);
    
    try {
      await scraper.closeBrowser();
    } catch (e) {}
  }
}

testIntegratedScraper();
