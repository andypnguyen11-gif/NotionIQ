# PRD.md

# AI Business Analyst for Notion

## Version

MVP v1

---

# 1. Product Overview

## Product Name (Temporary)

Possible names:

- NotionIQ
- Operator for Notion
- Insight Agent
- Workspace Analyst

---

# Product Vision

Create an AI business analyst that lives inside Notion.

Users connect their Notion workspace, select important databases, and receive intelligent business reports, insights, warnings, and recommended actions directly inside Notion.

The product does NOT replace Notion dashboards.

Notion dashboards answer:

"What happened?"

This product answers:

"Why did this happen and what should I do next?"

---

# Product Positioning

## Notion Native Dashboards

Example:

Revenue Chart

Inventory Table

Project Status

Sales Pipeline

User responsibility:

- Build dashboard
- Pick metrics
- Interpret numbers
- Decide actions

---

## AI Business Analyst

Example:

Weekly Business Review

"Revenue decreased 18% this month.

The biggest cause appears to be a 35% decrease in new inventory listings.

Your highest ROI category remains vintage jackets.

Recommended actions:

1. Source 15 new jackets this week
2. Discount inventory older than 120 days
3. Reduce shoe purchases due to lower margins"

---

# Core Philosophy

Data → Understanding → Action

Do not give users more dashboards.

Give users decisions.

---

# 2. Problem Statement

Many small businesses already operate inside Notion.

They use Notion for:

- Inventory
- Sales tracking
- CRM
- Projects
- Content calendars
- Goals
- Expenses

However, users struggle with:

- Understanding trends
- Identifying hidden problems
- Knowing what changed
- Finding business risks
- Making decisions from their data

Most users do not need another chart.

They need someone to review their business every week.

---

# 3. Target Users

## User Type 1

Small Business Owner

Examples:

- Resellers
- Etsy sellers
- Freelancers
- Agencies
- Consultants

## Pain Points

"I track everything but never review it."

"I have data but don't know what it means."

"I don't know what I should focus on."

---

# User Stories

## Story 1 — Connect Workspace

As a small business owner,

I want to connect my Notion workspace,

so my AI analyst can review my existing data.

---

Acceptance Criteria:

- User authenticates with Notion OAuth
- User grants workspace permissions
- User selects databases
- Connection is stored securely

---

# Story 2 — AI Understands My Business

As a business owner,

I want AI to understand my workspace automatically,

so I don't manually configure analytics.

Example:

Database:

Inventory Tracker

Fields:

purchase_price

sold_price

category

date_sold

AI detects:

Business:

Reseller

Metrics available:

- Revenue
- Profit
- ROI
- Inventory health

---

Acceptance Criteria:

- AI identifies database purpose
- AI maps fields correctly
- User can confirm mappings
- User can correct mistakes

---

# Story 3 — Weekly Business Review

As a business owner,

I want a weekly report created in Notion,

so I understand my business performance.

Example Output:

# Weekly Business Review

## Summary

Your revenue increased 22%.

The biggest driver was vintage jackets.

## Wins

Your jacket category generated your highest ROI.

## Problems

32 items have not sold in 90+ days.

## Suggested Actions

☐ Discount stale inventory

☐ Source more jackets

☐ Review shipping costs

---

Acceptance Criteria:

- Report page created in Notion
- Report contains metrics
- Report contains AI explanation
- Report contains actions

---

# Story 4 — AI Finds Problems

As a user,

I want AI to warn me about issues,

so I can fix problems earlier.

Examples:

Inventory:

"Your average days-to-sell increased from 20 days to 45 days."

Sales:

"You rely on one customer for 60% of revenue."

Projects:

"Your completion rate dropped 30%."

---

Acceptance Criteria:

- System detects meaningful changes
- AI explains possible causes
- AI recommends next steps

---

# Story 5 — Business Memory

As a user,

I want my AI analyst to remember previous reports,

so it can identify repeated problems.

Example:

Week 1:

"Inventory aging is increasing."

Week 2:

"Inventory aging continues."

Week 3:

"You have ignored stale inventory for 3 weeks. This is now your biggest cash flow issue."

---

Acceptance Criteria:

- Previous reports stored
- Historical trends analyzed
- Repeated issues detected

---

# 4. MVP Features

# Feature 1

Authentication

## Purpose

Manage user accounts.

## Stack

Next.js

Clerk

Required:

- Signup
- Login
- Logout
- Protected routes

---

# Feature 2

Notion OAuth Integration

Purpose:

Connect workspace securely.

Requirements:

- OAuth connection
- Store workspace
- Store encrypted token
- Disconnect workspace

---

# Feature 3

Workspace Scanner

Purpose:

Understand user's Notion structure.

Scan:

- Databases
- Properties
- Relations
- Property types
- Sample rows

Example:

Input:

Database name:

Deals

Properties:

client

amount

status

AI understands:

CRM / Sales pipeline

---

# Feature 4

AI Schema Mapper

Purpose:

Remove manual setup.

Responsibilities:

Analyze:

- Database names
- Properties
- Relationships

Return:

- Business type
- Data model
- Available insights

Example:

{
databaseType:"inventory",
businessType:"reseller",
metrics:[
"profit",
"roi",
"inventory_age"
]
}

---

# Feature 5

Analytics Engine

Purpose:

Calculate facts.

IMPORTANT:

AI NEVER calculates metrics.

Correct:

Analytics Engine:

Revenue = $20,000

AI:

"Revenue increased because..."

---

Metrics MVP:

Revenue

Profit

Growth %

Inventory aging

Project completion

Customer activity

---

# Feature 6

Insight Agent

Purpose:

Turn numbers into understanding.

Input:

{
revenueChange:-20,
inventoryAge:+40
}

Output:

"Revenue dropped 20%.

The likely cause is slower inventory turnover.

Recommended action:

Review items older than 90 days."

---

# Feature 7

Notion Report Writer

Purpose:

Keep user inside Notion.

Creates:

AI Business Analyst Page

Structure:

🤖 AI Business Review

Summary

Metrics

Wins

Warnings

Recommended Actions

---

# Feature 8

Scheduled Reviews

Purpose:

Automatic analyst behavior.

Options:

Weekly

Monthly

Flow:

Schedule triggers

↓

Fetch data

↓

Analyze

↓

Generate report

↓

Update Notion

---

# 5. Technical Architecture

Frontend:

Next.js

TypeScript

Tailwind

shadcn/ui

---

Backend:

Next.js API Routes

Future:

NestJS/Fastify if needed

---

Database:

Postgres

ORM:

Prisma

Tables:

User

NotionConnection

Workspace

DatabaseMapping

AnalysisRun

Report

Insight

ActionItem

---

Background Jobs:

BullMQ

Redis

Used for:

- scheduled reports
- long-running analysis
- AI processing

---

AI:

MVP:

Custom agents

Agents:

WorkspaceAnalyzerAgent

InsightAgent

ReportWriterAgent

Future:

LangGraph

---

Hosting:

MVP:

Vercel

Neon/Supabase

Upstash Redis

---

# 6. AI Guardrails

## Rule 1

AI does not calculate numbers.

Bad:

AI says:

"Profit is $10,000"

Good:

Backend:

profit = revenue - cost

AI:

"Profit improved because..."

---

## Rule 2

Every insight must reference data.

Bad:

"You should grow your business."

Good:

"Your average selling price dropped 20%, causing lower profit."

---

## Rule 3

AI should admit uncertainty.

Example:

"The likely reason appears to be..."

not:

"The reason is..."

---

# 7. Not Included In MVP

Do NOT build:

- Dashboard builder
- Advanced charts
- Custom BI reports
- Mobile app
- Slack integration
- Email reports
- Google Sheets
- Airtable
- QuickBooks
- Shopify
- Team accounts
- Enterprise permissions
- Auto database editing
- Full workspace restructuring

---

# 8. Major Technical Risks

# Risk 1

Notion API limitations

Problem:

Cannot access certain information.

Mitigation:

Prototype Notion scanner early.

---

# Risk 2

AI gives generic advice

Solution:

Provide structured metrics.

Require evidence.

---

# Risk 3

Supporting too many users

Problem:

Every Notion workspace differs.

Solution:

Start with niches.

First supported:

Small businesses:

- Inventory
- Sales
- CRM

---

# Risk 4

Competing with Notion

Avoid building:

Charts

Dashboards

Views

Focus on:

Interpretation

Recommendations

Business memory

---

# 9. Future Features

## AI Chat

Ask:

"Why did sales fall?"

AI:

"Your inventory additions dropped 40%."

---

## Auto Actions

AI creates:

Tasks

Follow-ups

Reports

---

## Business Integrations

Future:

Stripe

Shopify

QuickBooks

---

# 10. Pricing Hypothesis

Free:

- 1 workspace
- Manual report
- Basic insights

Pro:

$10-$15/month

Includes:

- Weekly reports
- Business memory
- Advanced insights
- Unlimited analysis

---

# 11. MVP Success Criteria

MVP is successful when:

A user can:

1. Create account

2. Connect Notion

3. Select databases

4. Generate AI review

5. Receive report inside Notion

6. Take recommended actions

Target:

First milestone:

100 paying users

$1,000+ MRR

---

# Final Product Direction

Not:

"Power BI for Notion"

Not:

"Notion dashboard replacement"

Build:

"An AI analyst that checks your Notion business every week and tells you what needs attention."
