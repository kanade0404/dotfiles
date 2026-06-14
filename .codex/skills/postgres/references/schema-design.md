---
title: PostgreSQL Schema Design
description: Schema design guide
tags: postgres, schema, primary-keys, data-types, foreign-keys, naming
---

# Schema Design

## Primary Keys

Prefer `BIGINT GENERATED ALWAYS AS IDENTITY`. Avoid random UUIDs (UUIDv4) as primary keys; use `uuidv7()` when you need UUIDs.

```sql
CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
```

Random UUID PKs (v4) can cause index fragmentation; UUIDs are also larger (16 vs 8 bytes for BIGINT) and can slow joins.

## Data Types

| Use | Avoid |
| --- | --- |
| `TEXT`, `VARCHAR` | Extension-specific types |
| `JSONB` | Custom ENUMs (use CHECK instead) |
| `TIMESTAMPTZ` | `TIMESTAMP` without time zone |
| `BIGINT`, `INTEGER` | Platform-specific types |

Prefer CHECK constraints over ENUM types — they're easier to modify:

```sql
CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'shipped', 'delivered'))
);
```

## Foreign Keys

- Always index FK columns (PostgreSQL does not auto-create these)
- Avoid circular FK dependencies
- Suggestion: use `ON DELETE CASCADE` or `ON DELETE SET NULL` explicitly

```sql
CREATE TABLE customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);
CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE
);
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
```

## Naming Conventions

- Tables: plural snake_case (`users`, `order_items`)
- Columns: singular snake_case (`created_at`, `user_id`)
- Indexes: `{table}_{column}_idx`
- Constraints: `{table}_{column}_{type}` (e.g., `orders_status_check`)

## General Guidelines

- Add `NOT NULL` to as many columns as possible
- Add `created_at TIMESTAMPTZ DEFAULT NOW()` to all tables
- Use `BIGINT` for all IDs and foreign keys, even on small tables
- Keep tables normalized; denormalize only for proven hot read paths
