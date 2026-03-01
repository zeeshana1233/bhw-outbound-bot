/**
 * Test OpenClaw on Real BHW Job Posts
 * 
 * Fetches first 3 leads from database and tests:
 * - Lead qualification
 * - Comment pitch generation (if qualified)
 * - DM outreach generation (if qualified)
 */

import aiEngine from './src/services/aiEngine.js';
import logger from './src/utils/logger.js';
import { pool } from './src/database/init.js';

async function testOpenClawOnRealLeads() {
  try {
    logger.info('=== Testing OpenClaw on Real BHW Job Posts ===\n');

    // Fetch first 3 leads from database
    const result = await pool.query(`
      SELECT id, thread_id, title, description, poster_username
      FROM leads
      ORDER BY created_at DESC
      LIMIT 3
    `);

    const leads = result.rows;

    if (leads.length === 0) {
      logger.error('No leads found in database. Run the scraper first.');
      return;
    }

    logger.info(`Found ${leads.length} leads to test\n`);
    logger.info('═══════════════════════════════════════════════════════════════\n');

    // Test each lead
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      
      logger.info(`\n┌─────────────────────────────────────────────────────────────┐`);
      logger.info(`│ LEAD ${i + 1}/${leads.length}: ${lead.title.substring(0, 45).padEnd(45)}│`);
      logger.info(`└─────────────────────────────────────────────────────────────┘\n`);

      logger.info(`📋 Title: ${lead.title}`);
      logger.info(`👤 Posted by: ${lead.poster_username || 'Unknown'}`);
      logger.info(`🔗 Thread ID: ${lead.thread_id}`);
      logger.info(`\n📝 Description:`);
      logger.info(`${lead.description.substring(0, 300)}${lead.description.length > 300 ? '...' : ''}\n`);

      // Step 1: Qualification
      logger.info('─────────────────────────────────────────────────────────────');
      logger.info('🤖 STEP 1: OpenClaw Qualification (GPT-4o mini)');
      logger.info('─────────────────────────────────────────────────────────────\n');

      const qualification = await aiEngine.qualifyLead(
        lead.title,
        lead.description
      );

      logger.info(`✅ Qualified: ${qualification.qualified ? '✓ YES' : '✗ NO'}`);
      logger.info(`📊 Confidence: ${qualification.confidence} (${Math.round((qualification.confidence ?? 0) * 100)}/100)`);
      logger.info(`💭 Reason: ${qualification.reason}`);
      
      if (qualification.qualified) {
        logger.info(`🎯 Pitch Angle: ${qualification.pitch_angle}\n`);

        // Step 2: Generate Comment Pitch
        logger.info('─────────────────────────────────────────────────────────────');
        logger.info('💬 STEP 2: Comment Pitch Generation');
        logger.info('─────────────────────────────────────────────────────────────\n');

        const commentPitch = await aiEngine.generateCommentPitch(
          lead.title,
          lead.description,
          qualification.pitch_angle
        );

        logger.info('📢 Generated Comment:');
        logger.info('┌─────────────────────────────────────────────────────────┐');
        logger.info(`│ ${commentPitch.split('\n').join('\n│ ')}`);
        logger.info('└─────────────────────────────────────────────────────────┘\n');

        // Step 3: Generate DM Outreach
        logger.info('─────────────────────────────────────────────────────────────');
        logger.info('📨 STEP 3: DM Outreach Generation');
        logger.info('─────────────────────────────────────────────────────────────\n');

        const dmOutreach = await aiEngine.generateDMOutreach(
          lead.title,
          lead.description,
          lead.poster_username || 'user',
          qualification.pitch_angle
        );

        logger.info('📬 Generated DM:');
        logger.info('┌─────────────────────────────────────────────────────────┐');
        logger.info(`│ ${dmOutreach.split('\n').join('\n│ ')}`);
        logger.info('└─────────────────────────────────────────────────────────┘\n');

      } else {
        logger.info('\n⏭️  Skipping pitch generation (not qualified)\n');
      }

      logger.info('═══════════════════════════════════════════════════════════════\n');

      // Small delay between leads
      if (i < leads.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info('\n✅ Test Complete!\n');
    logger.info('Summary:');
    logger.info(`  Total leads tested: ${leads.length}`);
    
    await pool.end();

  } catch (error) {
    logger.error('Test failed:', error);
    
    if (error.message && error.message.includes('API key')) {
      logger.error('\n⚠️  Make sure you have OPENAI_API_KEY set in your .env file');
    }
    
    await pool.end();
    process.exit(1);
  }
}

// Run test
testOpenClawOnRealLeads();
