# AGENT.md

## Project

- Project: `southeast-asian-student-service-platform`
- Stack: Node.js + Express, MySQL, JWT, Helmet
- Type: international student information management service

## Runtime

- Service port: `3000` from `.env.example` `PORT`.
- Local URL: `http://localhost:3000`.
- Dev: `npm run dev`.
- Start: `npm start`.
- Init DB: `npm run db:init`.
- Seed data: `npm run db:seed`.

## Database

- Type: MySQL.
- Database name: `international_student_platform`.
- Env file: `.env` based on `.env.example`.
- Variables: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, `JWT_EXPIRES_IN`.
- Schema: `database/schema.sql`.
- Keep real passwords only in local `.env`.

## Codex Notes

- Maintain relationships among users, students, teachers, classes, grades, visas, dormitories, and nationalities.
- If schema or seed logic changes, update README and this file.

## GitHub Commit Language

- Use English for all GitHub commit messages and pull/push related commit notes.
