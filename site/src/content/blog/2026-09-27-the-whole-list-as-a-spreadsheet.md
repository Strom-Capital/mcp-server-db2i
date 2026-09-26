---
title: The whole list as a spreadsheet
description: Ask for all the open orders for a customer and get a file you can open in Excel, not a summary in the chat.
date: 2026-09-27T10:00:00Z
audience: business
icon: book-open-text
tags: [business, exports]
---

An AI assistant is good at answering a question. "Which customers ordered less this quarter?" gets a short answer with the numbers. But some questions need every row: the full list of open orders for one customer, every invoice more than 60 days overdue, all items bought from two suppliers. You want to sort it, filter it, and send it on. Until now, the assistant could only summarize.

## Ask for the file

With the latest version, you can ask for the list as a file:

> Give me all open orders for customer 1001 as a spreadsheet.

The assistant looks up the data the same way as for any question, and hands you an Excel or CSV file with every row. In claude.ai you get a download link in the chat. Open it, and the list is in Excel, ready to work with.

A few details that make this useful day to day:

- **Every row, not a sample.** A normal answer shows the assistant a limited number of rows. A file holds the whole result, up to the limit your IT team sets.
- **The list doesn't go through the chat.** The assistant only sees how many rows there are and a few examples. The file itself comes from your own server.
- **Hidden stays hidden.** Fields your IT team has hidden, such as personal details, are hidden in the file too.
- **Just values.** The file holds values only, no formulas, so it opens cleanly and does nothing unexpected.

## The link is short-lived

The download link works for 15 minutes and a few downloads, then the file is deleted. Anyone who has the link during that time can download the file, so treat the link the same way you would treat the file: don't paste it into a group chat you wouldn't send the spreadsheet to.

## Or ask from Excel

If your company uses Claude for Excel, you can also ask in the Claude sidebar in Excel and work with the answer right there. It uses the same connection and sign-in as claude.ai, so there is nothing extra to set up for it.

## What your IT team turns on

Exports are off until your IT team turns them on. They also choose the limits: how many rows a file may have, how long a link lasts, and how many exports can run at the same time, so a large export doesn't slow down your system. Everything else stays as it is: the assistant can only read, never change, and people sign in with their own user.

## Next step

If your company doesn't use it yet, the [page for business teams](/business) explains what it does and what your IT team needs to know. If it's already running, ask your IT team whether exports are turned on, then try it with a list you currently build by hand.
