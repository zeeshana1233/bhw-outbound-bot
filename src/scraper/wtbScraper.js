import logger from '../utils/logger.js';
import { randomDelay, sleep, extractThreadId, getThreadAgeCategory } from '../utils/helpers.js';
import bhwSession from '../utils/bhwSession.js';
import { createLead, updateLeadQualification, getLeadById, markLeadContacted } from '../database/queries.js';
import { config } from '../config/config.js';

const WTB_URL = config.wtb?.url || 'https://www.blackhatworld.com/forums/want-to-buy.92/';

/**
 * Scrape Page 1 of BlackHatWorld's Want to Buy forum using authenticated bhwSession.
 * Filters strictly for posts created TODAY and saves them directly to DB with tag ['wtb'].
 */
export async function scrapeWtbThreads() {
  if (!config.wtb?.enabled) {
    logger.info('  [WTB] Module disabled (WTB_ENABLED=false) — skipping scrape.');
    return { threads: [], inspected: 0, todayFound: 0 };
  }

  logger.info(`\n📡  [WTB] Scraping Want-to-Buy forum via authenticated session: ${WTB_URL}`);

  try {
    await bhwSession.ensureAuthenticated();
    const page = bhwSession.getPage();

    // Navigate to WTB listing page
    await page.goto(WTB_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(randomDelay(2000, 3500));

    // Extract threads from page 1
    const rawThreads = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('.structItem--thread, .p-body-main .structItem');

      rows.forEach(row => {
        // Skip sticky / pinned threads
        if (row.classList.contains('structItem--sticky') || row.querySelector('.structItem-status--sticky')) {
          return;
        }

        const titleEl = row.querySelector('.structItem-title a[data-tp-primary], .structItem-title a:last-child');
        const userEl = row.querySelector('.structItem-parts .username, .structItem-cell--main .username');
        const timeEl = row.querySelector('.structItem-startDate time, time.u-dt');

        if (!titleEl) return;

        const title = titleEl.innerText.trim();
        const url = titleEl.href;
        const posterUsername = userEl ? userEl.innerText.trim() : null;
        const postDate = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText.trim()) : null;

        results.push({
          title,
          url,
          posterUsername,
          postDate,
        });
      });

      return results;
    });

    logger.info(`  [WTB] Listed ${rawThreads.length} thread cards on Page 1.`);

    if (rawThreads.length === 0) {
      return { threads: [], inspected: 0, todayFound: 0 };
    }

    const todayLeads = [];
    let todayCount = 0;

    for (const t of rawThreads) {
      const threadId = extractThreadId(t.url);
      if (!threadId) continue;

      // Check post age (Today-only rule)
      const ageCategory = getThreadAgeCategory(t.postDate);
      const isToday = ageCategory === 'fresh';

      if (config.wtb?.todayOnly && !isToday) {
        continue; // skip old posts
      }

      todayCount++;

      // Create lead in DB with 'wtb' tag and is_qualified = true (No AI gate needed)
      const lead = await createLead({
        threadId,
        threadUrl: t.url,
        title: t.title,
        description: t.title,
        posterUsername: t.posterUsername,
        posterUrl: t.posterUsername ? `https://www.blackhatworld.com/members/${t.posterUsername.toLowerCase()}/` : '',
        postDate: t.postDate ? new Date(t.postDate) : new Date(),
        threadAgeCategory: ageCategory,
        tags: ['wtb'],
      });

      if (lead) {
        // Mark explicitly as qualified for WTB (no AI gate needed)
        await updateLeadQualification(lead.id, true, 'Want-to-Buy section lead', 1.0, ['wtb']).catch(() => {});
      }

      if (lead) {
        todayLeads.push({
          id: lead.id,
          threadId,
          threadUrl: t.url,
          title: t.title,
          posterUsername: t.posterUsername,
          postDate: t.postDate,
          alreadyExisted: lead.created_at && (new Date() - new Date(lead.created_at) > 60000),
          commented: lead.commented,
          dmSent: lead.dm_sent,
        });
      }
    }

    logger.info(`  [WTB] Found ${todayCount} thread(s) posted TODAY (saved with tag ['wtb']).`);
    return {
      threads: todayLeads,
      inspected: rawThreads.length,
      todayFound: todayCount,
    };

  } catch (err) {
    logger.error(`  [WTB] Scraper error: ${err.message}`);
    return { threads: [], inspected: 0, todayFound: 0, error: err.message };
  }
}
