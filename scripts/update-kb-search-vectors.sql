-- Update search vectors for all KB articles
-- This ensures that articles inserted before the trigger was created have their search_vector populated
-- Run this after inserting articles: psql -d your_database -f scripts/update-kb-search-vectors.sql

UPDATE kb_articles
SET 
  search_vector = 
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(content, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(keywords, ' '), '')), 'B'),
  updated_at = NOW()
WHERE search_vector IS NULL OR updated_at < created_at;

-- Verify update
SELECT 
  COUNT(*) as total_articles,
  COUNT(*) FILTER (WHERE search_vector IS NOT NULL) as articles_with_search_vector,
  COUNT(*) FILTER (WHERE search_vector IS NULL) as articles_without_search_vector
FROM kb_articles;

