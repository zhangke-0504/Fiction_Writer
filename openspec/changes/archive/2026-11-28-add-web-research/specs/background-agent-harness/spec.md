## ADDED Requirements

### Requirement: The main Agent can research the public web on demand

Harness SHALL make `web_search` and `web_fetch` discoverable as read-only tools for the main Agent. The Agent SHALL choose when to use them through the existing natural-language Session flow. `web_search` SHALL use DuckDuckGo by default without user-provided credentials and return bounded source titles, public URLs and available snippets. `web_fetch` SHALL accept a public HTTP(S) URL and return a bounded extract and its source URL. The tools SHALL follow Run cancellation and bound their response times. Searches with no matches and failed network requests SHALL have distinguishable outcomes.

#### Scenario: Answer a current question with sources

- **WHEN** an author requests current information in the Session composer
- **THEN** the main Agent can discover and call the web tools, receive source data as a tool result, and use it in the final assistant reply in the same Session

#### Scenario: Read a link provided by the author

- **WHEN** the author gives an accessible public page URL and asks about its contents
- **THEN** the main Agent can read the page directly without a search

#### Scenario: Web research fails

- **WHEN** the search service refuses a request, the page cannot be read, or a network request times out
- **THEN** the tool returns an observable failure to the Agent for this Run
