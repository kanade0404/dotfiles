---
name: api-design
description: REST API design patterns including resource naming, status codes, pagination, filtering, error responses, versioning, and rate limiting for production APIs.
---

# API Design Patterns

Conventions and best practices for designing consistent, developer-friendly REST APIs.

## When to Activate

- Designing new API endpoints
- Reviewing existing API contracts
- Adding pagination, filtering, or sorting
- Implementing error handling for APIs
- Planning API versioning strategy

## Resource Design

### URL Structure

```
GET    /api/v1/users
GET    /api/v1/users/:id
POST   /api/v1/users
PUT    /api/v1/users/:id
PATCH  /api/v1/users/:id
DELETE /api/v1/users/:id
GET    /api/v1/users/:id/orders
POST   /api/v1/orders/:id/cancel
```

### Naming Rules
- Resources are nouns, plural, lowercase, kebab-case
- Query params for filtering: `?status=active`
- Nested resources for ownership: `/users/123/orders`

## HTTP Methods and Status Codes

| Method | Idempotent | Use For |
|--------|-----------|---------|
| GET | Yes | Retrieve resources |
| POST | No | Create resources, trigger actions |
| PUT | Yes | Full replacement |
| PATCH | No* | Partial update |
| DELETE | Yes | Remove a resource |

### Status Code Reference
- 200 OK, 201 Created, 204 No Content
- 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity, 429 Too Many Requests
- 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable

## Pagination

### Offset-Based (Simple)
```
GET /api/v1/users?page=2&per_page=20
```

### Cursor-Based (Scalable)
```
GET /api/v1/users?cursor=eyJpZCI6MTIzfQ&limit=20
```

## Filtering, Sorting, and Search

```
GET /api/v1/orders?status=active&customer_id=abc-123
GET /api/v1/products?price[gte]=10&price[lte]=100
GET /api/v1/products?sort=-created_at
GET /api/v1/products?q=wireless+headphones
GET /api/v1/users?fields=id,name,email
```

## Rate Limiting

| Tier | Limit | Use Case |
|------|-------|----------|
| Anonymous | 30/min | Public endpoints |
| Authenticated | 100/min | Standard API access |
| Premium | 1000/min | Paid API plans |

## Versioning

Start with `/api/v1/`. Maintain at most 2 active versions. Non-breaking changes don't need a new version.

## API Design Checklist

- [ ] Resource URL follows naming conventions
- [ ] Correct HTTP method used
- [ ] Appropriate status codes returned
- [ ] Input validated with schema (Zod, Pydantic)
- [ ] Error responses follow standard format
- [ ] Pagination implemented for list endpoints
- [ ] Authentication required
- [ ] Rate limiting configured
