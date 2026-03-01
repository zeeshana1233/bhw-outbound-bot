import logger from '../utils/logger.js';
import aiEngine from '../services/aiEngine.js';
import { updateLeadQualification } from '../database/queries.js';

/**
 * Niche Qualification Engine
 * Uses GPT-4o mini to determine if a job post matches Bitbash's services
 * Based on proven BHW scraper qualification logic
 */

export async function qualifyLead(lead) {
  logger.info(`Qualifying lead ${lead.id}: "${lead.title}"`);
  
  try {
    // Call OpenClaw (GPT-4o mini) for qualification
    const result = await aiEngine.qualifyLead(lead.title, lead.description);
    
    // Update lead in database
    await updateLeadQualification(
      lead.id,
      result.qualified,
      result.reason,
      result.confidence
    );
    
    logger.info(`Lead ${lead.id} qualification: ${result.qualified ? 'APPROVED' : 'REJECTED'} (Confidence: ${result.confidence}, Tier: ${result.tier})`);
    
    return result;
  } catch (error) {
    logger.error(`Error qualifying lead ${lead.id}:`, error);
    
    // Default to not qualified if error occurs
    await updateLeadQualification(
      lead.id,
      false,
      `Error during qualification: ${error.message}`,
      0
    );
    
    return {
      qualified:  false,
      confidence: 0,
      tier:       'skip',
      reason:     `Error: ${error.message}`,
      pitch_angle: '',
    };
  }
}
