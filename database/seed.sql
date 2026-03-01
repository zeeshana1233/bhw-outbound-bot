-- Seed data for niche keywords
-- Based on Bitbash's service offerings

-- Primary keywords (high relevance)
INSERT INTO niche_keywords (keyword, category, weight) VALUES
('automation', 'primary', 5),
('bot', 'primary', 5),
('scraping', 'primary', 5),
('scraper', 'primary', 5),
('web scraping', 'primary', 5),
('data extraction', 'primary', 5),
('shopify', 'primary', 4),
('ecommerce', 'primary', 4),
('chrome extension', 'primary', 5),
('browser automation', 'primary', 5),
('puppeteer', 'primary', 4),
('selenium', 'primary', 4),
('python script', 'primary', 4),
('api integration', 'primary', 4),
('webhook', 'primary', 3),
('zapier', 'primary', 3),
('make.com', 'primary', 3),
('n8n', 'primary', 3);

-- Secondary keywords (moderate relevance)
INSERT INTO niche_keywords (keyword, category, weight) VALUES
('web app', 'secondary', 3),
('dashboard', 'secondary', 3),
('saas', 'secondary', 3),
('backend', 'secondary', 2),
('frontend', 'secondary', 2),
('full stack', 'secondary', 2),
('javascript', 'secondary', 2),
('node.js', 'secondary', 2),
('react', 'secondary', 2),
('database', 'secondary', 2),
('api', 'secondary', 3);

-- Exclude keywords (not our niche)
INSERT INTO niche_keywords (keyword, category, weight) VALUES
('mobile app', 'exclude', -10),
('ios', 'exclude', -10),
('android', 'exclude', -10),
('flutter', 'exclude', -10),
('react native', 'exclude', -10),
('swift', 'exclude', -10),
('kotlin', 'exclude', -10),
('game', 'exclude', -10),
('unity', 'exclude', -10),
('unreal', 'exclude', -10),
('blockchain', 'exclude', -8),
('smart contract', 'exclude', -8),
('crypto', 'exclude', -8),
('NFT', 'exclude', -8),
('wordpress', 'exclude', -6),
('graphic design', 'exclude', -10),
('logo', 'exclude', -10),
('video editing', 'exclude', -10),
('SEO', 'exclude', -5),
('content writing', 'exclude', -10);
