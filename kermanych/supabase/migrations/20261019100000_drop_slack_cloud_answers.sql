-- Slack cloud answers are removed from Kermanych (docs/specs/2026-10-19-remove-slack-cloud-answers.md):
-- Kermanych no longer sends messages from the cloud. This undoes
-- 20261016090000_slack_cloud_answers.sql, which stays in the history because the hosted
-- project has already applied it. The documentation bot answers only from a member's
-- machine over Socket Mode again.
--
-- DESTRUCTIVE: every workspace's stored cloud-answer secrets (Slack bot token, signing
-- secret, AI API key) and the redelivery log are deleted. That is the point: no Slack or AI
-- secret is left in the cloud.

-- ── 1. the functions ──────────────────────────────────────────────────────────

-- First: the plpgsql ones name the tables only in their bodies, which Postgres does not
-- track as a dependency.
drop function if exists public.set_slack_cloud(uuid, boolean, text, text, text, text, text, text);
drop function if exists public.delete_slack_cloud(uuid);
drop function if exists public.get_slack_cloud_status(uuid);
drop function if exists public.slack_cloud_config(uuid);
drop function if exists public.slack_cloud_claim_event(uuid, text);
drop function if exists public.slack_cloud_indexed_projects(uuid);
drop function if exists public.slack_cloud_match_docs(uuid, uuid, halfvec, text, int, text);

-- ── 2. the tables ─────────────────────────────────────────────────────────────

-- The events reference the cloud row, so they go first.
drop table if exists public.slack_cloud_events;
drop table if exists public.workspace_slack_cloud;
