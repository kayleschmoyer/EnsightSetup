-- Zone levels (is_zone = true) belong to a parent floor level. This link was
-- previously only held in memory (level.parentLevelId) and silently dropped on
-- save — a real relational column both persists it and lets the database
-- cascade zone deletion when the parent floor is deleted, matching the app's
-- in-memory behavior in LevelSelector's handleDeleteLevel.
alter table levels
  add column parent_level_id uuid references levels(id) on delete cascade;

create index idx_levels_parent_level on levels(parent_level_id);
