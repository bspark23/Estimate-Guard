# Estimate Guard for Jira: Privacy Policy

Last updated: November 18, 2026

Estimate Guard is a Forge app for Jira Cloud by Mbata Blessing Adaoma ("we"). This policy explains what the app reads, what it stores and where.

## What the app reads
When you use Estimate Guard, it reads the following from your Jira site, using your own Jira permissions:
- Completed and open work items in the project you are viewing: key, summary, issue type, labels, status, original estimate, time spent, and created and resolved dates.

## What the app stores
All data is stored in Forge storage, which Atlassian hosts on its own platform. Nothing leaves Atlassian's platform.
- **Warnings and receipts:** for each work item the app warns about or grades, it keeps the work item key, summary, estimate, hours and the result of the warning. This is used to show "were our warnings right?".
- **Recount records:** when you click Recount, it keeps the estimate before and after.
- **Short-lived cache:** a copy of the search results, kept per user for at most 2 minutes so the app stays fast. It is keyed by the Atlassian account ID, so each user only sees results that their own permissions allow.

The app does not store names, email addresses or any other personal profile data.

## What the app changes in Jira
The app changes a work item's original estimate only when a user clicks the Recount button, and it does so as that user. If a site admin adds the Estimate Guard workflow rule, the rule can stop a work item from moving to In Progress. It never changes anything else.

## Sharing
We do not sell or share data with anyone. The app makes no calls to servers outside Atlassian and does not use any external AI service.

## Retention and deletion
Data stays in the app's Forge storage until the app is uninstalled. Atlassian deletes it after uninstallation according to its Forge data retention policy.

## Contact
Questions: adaoma2826@gmail.com
