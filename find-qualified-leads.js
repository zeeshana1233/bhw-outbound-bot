/**
 * Find Qualified Leads - No Login Required
 * 
 * This script:
 * 1. Runs the scraper WITHOUT login session
 * 2. Scrapes recent BHW threads
 * 3. Uses OpenClaw to qualify leads
 * 4. Shows you qualified leads ready for commenting
 * 
 * Safe to run - uses public browsing, no login needed!
 */

import { BHWScraper } from './src/scraper/index.js';
import aiEngine from './src/services/aiEngine.js';
import logger from './src/utils/logger.js';
import { pool } from './src/database/init.js';

async function findQualifiedLeads() {
  const scraper = new BHWScraper();
  
  try {
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('🔍 FINDING QUALIFIED LEADS (No Login Required)');
    logger.info('═══════════════════════════════════════════════════════════\n');

    // Run scraper to get fresh threads
    logger.info('📡 Scraping BHW Hire-a-Freelancer section...\n');
    
    await scraper.initBrowser();
    const scrapeResult = await scraper.scrapeAndStore();
    await scraper.closeBrowser();
    
    logger.info(`\n✅ Scraping complete!`);
    logger.info(`   New threads: ${scrapeResult.newThreads || 0}`);
    logger.info(`   Duplicates skipped: ${scrapeResult.duplicateThreads || 0}\n`);
    logger.info('───────────────────────────────────────────────────────────\n');

    // Get unqualified leads from database
    logger.info('🤖 Qualifying leads with OpenClaw (GPT-4o mini)...\n');
    
    const queryResult = await pool.query(`
      SELECT id, title, description, thread_url, poster_username
      FROM leads
      WHERE is_qualified IS NULL
      ORDER BY post_date DESC
      LIMIT 20
    `);

    const unqualifiedLeads = queryResult.rows;
    
    if (unqualifiedLeads.length === 0) {
      logger.info('No new leads to qualify - all caught up!\n');
      logger.info('TIP: Run this script again later for fresh threads.');
      return;
    }

    logger.info(`Found ${unqualifiedLeads.length} unqualified leads\n`);
    logger.info('═══════════════════════════════════════════════════════════\n');

    let qualifiedCount = 0;
    let rejectedCount = 0;
    const qualifiedLeads = [];

    // Qualify each lead
    for (const lead of unqualifiedLeads) {
      logger.info(`\n📋 Qualifying: "${lead.title.substring(0, 60)}..."`);
      
      const qualification = await aiEngine.qualifyLead(
        lead.title,
        lead.description
      );

      // Update database
      await pool.query(`
        UPDATE leads 
        SET 
          is_qualified = $1,
          niche_match_score = $2,
          qualification_reason = $3,
          pitch_angle = $4
        WHERE id = $5
      `, [
        qualification.qualified,
        Math.round((qualification.confidence || 0) * 100),
        qualification.reason,
        qualification.pitch_angle,
        lead.id
      ]);

      if (qualification.qualified) {
        qualifiedCount++;
        qualifiedLeads.push({
          ...lead,
          score: qualification.confidence,
          pitch_angle: qualification.pitch_angle
        });
        logger.info(`   ✅ QUALIFIED (confidence: ${qualification.confidence}, tier: ${qualification.tier})`);
        logger.info(`   💡 ${qualification.pitch_angle}`);
      } else {
        rejectedCount++;
        logger.info(`   ❌ REJECTED (confidence: ${qualification.confidence})`);
        logger.info(`   💭 ${qualification.reason}`);
      }
    }

    // Show summary
    logger.info('\n═══════════════════════════════════════════════════════════');
    logger.info('📊 QUALIFICATION RESULTS');
    logger.info('═══════════════════════════════════════════════════════════\n');
    logger.info(`✅ Qualified: ${qualifiedCount}`);
    logger.info(`❌ Rejected: ${rejectedCount}`);
    logger.info(`📊 Total Checked: ${unqualifiedLeads.length}\n`);

    // Show qualified leads
    if (qualifiedCount > 0) {
      logger.info('═══════════════════════════════════════════════════════════');
      logger.info('🎯 QUALIFIED LEADS READY FOR COMMENTING:');
      logger.info('═══════════════════════════════════════════════════════════\n');

      qualifiedLeads.forEach((lead, index) => {
        logger.info(`${index + 1}. ${lead.title}`);
        logger.info(`   Posted by: ${lead.poster_username}`);
        logger.info(`   Score: ${lead.score} (confidence)`);
        logger.info(`   Pitch: ${lead.pitch_angle}`);
        logger.info(`   URL: ${lead.thread_url}\n`);
      });

      logger.info('═══════════════════════════════════════════════════════════');
      logger.info('✅ READY TO COMMENT!');
      logger.info('═══════════════════════════════════════════════════════════\n');
      logger.info('Next steps:');
      logger.info('  1. Review the qualified leads above');
      logger.info('  2. Use test-bhw-session.js to login (if not already)');
      logger.info('  3. Use comment engine to post comments (DRY RUN first!)\n');
    } else {
      logger.info('═══════════════════════════════════════════════════════════');
      logger.info('😕 NO QUALIFIED LEADS FOUND');
      logger.info('═══════════════════════════════════════════════════════════\n');
      logger.info('All scraped threads were rejected (SEO/marketing/etc).');
      logger.info('Run this script again later when new threads are posted.\n');
    }

  } catch (error) {
    logger.error('Error finding qualified leads:', error);
  } finally {
    // Clean up
    try {
      await scraper.closeBrowser();
    } catch (e) {}
    
    await pool.end();
    process.exit(0);
  }
}

// Run the search
findQualifiedLeads();
