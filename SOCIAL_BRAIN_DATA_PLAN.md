# Social Brain — Training Data Collection Plan

**For:** External Developer (Outsourced)
**Purpose:** Scrape and prepare clean BHW forum data for Social Brain vector indexing
**Volume:** 50 posts per forum

---

## What You Are Doing

You are scraping discussion posts and their comments from specific BlackHatWorld forums. The output will be used as training data for an AI retrieval system. The goal is clean, structured, ready-to-index data — nothing else.

---

## Forums to Scrape

| Forum | URL |
|---|---|
| Making Money | https://www.blackhatworld.com/forums/making-money.12/ |
| Joint Ventures | https://www.blackhatworld.com/forums/joint-ventures.65/ |
| Pay Per Click | https://www.blackhatworld.com/forums/pay-per-click.13/ |
| Social Media | https://www.blackhatworld.com/forums/social-media.200/ |
| AI in Digital Marketing | https://www.blackhatworld.com/forums/ai-artificial-intelligence-in-digital-marketing.252/ |
| Programming | https://www.blackhatworld.com/forums/programming.79/ |
| Scripting | https://www.blackhatworld.com/forums/scripting.59/ |
| Web Design | https://www.blackhatworld.com/forums/web-design.126/ |
| Offline Marketing | https://www.blackhatworld.com/forums/offline-marketing.132/ |
| Junior VIP Zone | https://www.blackhatworld.com/forums/junior-vip-zone.54/ |
| Misc | https://www.blackhatworld.com/forums/misc.18/ |

---

## Post Filtering Rules (What to Keep)

For each forum, collect only posts that pass **all** of the following:

**Keep the post if:**
- It is a genuine question or discussion from a community member
- The original poster is asking for help, sharing an experience, or starting a discussion
- The thread has at least 3 replies
- The thread has real engagement (replies with actual content, not just one-word answers)

**Discard the post if it matches any of the following:**
- The thread is a sales thread (selling a service, selling accounts, selling traffic, etc.)
- The thread title contains words like: "For Sale", "I Offer", "Service", "Hire Me", "Buy", "Selling", "[SELLING]", "[FOR SALE]", "LTD", "Discount", "BST", "Marketplace"
- The post is a review or testimonial for a service
- The post is an introduction thread ("Hello BHW, I'm new here")
- The post is spam or has no real question/discussion

**AI Filtering Prompt** (run this on every post title + body before including it):

```
You are a content classifier for a forum dataset.

Classify the following forum post as either ORGANIC or MARKETING.

ORGANIC = A genuine community discussion, question, problem, experience share, or advice request. The author is not trying to sell anything.

MARKETING = A sales thread, service listing, marketplace post, BST (Buy Sell Trade), or any post where the primary intent is to sell something or promote a paid offering.

Respond with only one word: ORGANIC or MARKETING.

Post Title: [INSERT TITLE]
Post Body: [INSERT FIRST 300 CHARS OF BODY]
```

Only keep posts classified as ORGANIC.

---

## Comment Filtering Rules (What Comments to Keep)

For each post, you will collect comments. Do not keep all comments. Apply the following:

**Keep a comment if:**
- It is a genuine reply that adds value to the discussion (advice, answer, explanation, counter-point, experience)
- The comment has substance — at least 2 sentences or contains specific actionable information
- The comment has a positive reaction count (likes/reactions > 0 is preferred, but not required if the content is clearly helpful)

**Discard a comment if:**
- It is a one-liner with no information value (e.g., "Nice post", "Thanks", "Following", "Watching", "Great work", "Bookmarked")
- It is a spam or self-promotion comment (user promoting their own service in the reply)
- It is a troll or off-topic comment with no relation to the thread
- It is a quote-only reply with no additional text added

**Comment selection:** From each post, keep the **top 5 most helpful comments** based on the rules above. If the post has fewer than 5 qualifying comments, keep all that qualify.

---

## Data Structure

Deliver one CSV file per forum. Each row = one post + one comment pairing.

### CSV Column Schema

| Column | Description |
|---|---|
| `forum_name` | Human-readable forum label (e.g., `making-money`, `joint-ventures`) |
| `forum_url` | The forum URL |
| `post_id` | BHW thread ID (from the URL) |
| `post_url` | Full URL of the thread |
| `post_title` | Thread title |
| `post_author` | Username of the thread starter |
| `post_author_rank` | User rank/title shown under their name (e.g., Junior Member, Elite Member) |
| `post_date` | Date the post was published (YYYY-MM-DD) |
| `post_body` | Full text of the original post (cleaned — no HTML tags, no quote blocks) |
| `comment_author` | Username of the commenter |
| `comment_author_rank` | User rank/title of the commenter |
| `comment_date` | Date the comment was published (YYYY-MM-DD) |
| `comment_body` | Full text of the comment (cleaned — no HTML tags, no quote blocks, no "Click to expand" artifacts) |
| `comment_position` | The comment's sequential position in the thread (e.g., 2, 3, 4) |

### Example Row (for reference only)

```
forum_name: making-money
post_title: how to monetize GI email traffic
post_body: I'm getting GI email traffic (3000 visitors per day, 30% from USA), but they're from multiple countries. How does GI emailer usually monetize such traffic?
comment_body: For the non-US traffic the standard move is to segment by country and route to geo-targeted offers. UK, CA, AU convert on most of the same offer types as the US. Survey routers like CPX Research, Theorem Reach, or ySense auto-serve by country and work globally. For LATAM — dating offers and app install CPA tend to outperform surveys. For Asia and tier 3 GEOs — push notification subscriptions are the most reliable via Monetag or PropellerAds.
```

---

## Comment Text Cleaning Rules

When cleaning comment text, apply the following:

- Remove all HTML tags
- Remove quoted reply blocks (the section where a user quotes a previous post before replying) — keep only the new text the commenter added
- Remove "Click to expand..." artifacts
- Remove signature blocks (text below a separator line at the bottom of a post, usually contains links or taglines)
- Remove emoji if they appear in bulk / decoratively, but keep single meaningful ones
- Normalize whitespace (no double blank lines, no trailing spaces)
- Do not paraphrase or rewrite any text — keep it exactly as written by the original author

---

## Output Files

Deliver one CSV per forum, named using this convention:

```
bhw_[forum-slug]_posts.csv
```

Examples:
- `bhw_making-money_posts.csv`
- `bhw_joint-ventures_posts.csv`
- `bhw_social-media_posts.csv`

Each file must have:
- A header row with the column names listed above
- 50 post rows minimum (meaning 50 unique threads, each may have multiple comment rows — one row per post+comment pair)
- UTF-8 encoding
- No BOM

---

## Volume Summary

| Forum | Posts Required |
|---|---|
| Making Money | 50 |
| Joint Ventures | 50 |
| Pay Per Click | 50 |
| Social Media | 50 |
| AI in Digital Marketing | 50 |
| Programming | 50 |
| Scripting | 50 |
| Web Design | 50 |
| Offline Marketing | 50 |
| Junior VIP Zone | 50 |
| Misc | 50 |
| **Total** | **550 posts** |

---

## Important Notes

- Do not generate, paraphrase, or rewrite any post or comment content. All text must be exactly as it appeared on BHW.
- Do not include posts from the Marketplace, BST, or any sales subforum even if they appear in the forum listing.
- If a forum has fewer than 50 qualifying organic posts, deliver as many as exist and flag it in a notes file.
- The `forum_name` tag on every row is required — this is used for indexing and retrieval filtering.
- Deliver raw CSV only. No additional processing, no embeddings, no databases.
