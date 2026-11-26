## ADDED Requirements

### Requirement: Fixed application viewport and independent workspace scrolling

Writer SHALL fit within the available window without a root document scrollbar. The chapter list, subject list, subject details, clue list, clue details, whole-book outline, and chapter body SHALL each offer native vertical scrolling when their visible content overflows. Wheel input over a region, including continued input at either boundary, SHALL leave the root document and neighboring regions at their current positions. Users SHALL be able to drag the overflowing region's scrollbar thumb. Read-only scroll regions SHALL also be reachable and scrollable by keyboard.

#### Scenario: Scroll chapter rows alongside a long asset list

- **WHEN** the chapter list and either asset list both exceed their available height
- **THEN** users can independently reach the last chapter and the last subject or clue, while the chapter count, search, and create action and the central title and create action remain visible

#### Scenario: Open and return from a long subject or clue

- **WHEN** a user scrolls an asset list and opens a subject or clue with a long body
- **THEN** its details open at the top, its title and return action remain accessible while scrolling, and the final content including clue relationships can be reached
- **AND** returning from details restores the corresponding list's prior scroll position within its current bounds

#### Scenario: Read and save a long outline or chapter in a short window

- **WHEN** a user opens a long outline or chapter, including at the minimum supported window size with Harness open
- **THEN** the editor content scrolls within its editor and the save control stays visible

#### Scenario: Reach long forms without root scrolling

- **WHEN** a basic information form, settings form, or modal extends beyond its available space
- **THEN** the user can reach its final fields and actions via scrolling within that page section or modal

### Requirement: Library pagination within the viewport

The library SHALL search the full collection using the existing title and author matching rules, preserve the collection's title order, and paginate the matching results by the number of complete rows that fit in the available list area. Page navigation SHALL display the current and total page counts whenever there are multiple pages and SHALL keep its controls reachable without scrolling the library or the root document. Boundary controls SHALL be disabled at their respective ends.

#### Scenario: Browse more books than fit in one page

- **WHEN** the collection exceeds the number of books that fit in the window
- **THEN** the user can visit every book in title order through previous and next controls, and every visible row and its book actions fit entirely in the list area

#### Scenario: Search a book from another page

- **WHEN** the user changes the query from a later page to match books outside that page
- **THEN** the library shows the first page of matches from the complete collection and shows the existing empty-results state if nothing matches

#### Scenario: Resize or delete from the last page

- **WHEN** the user resizes the library window
- **THEN** the library recalculates the number of rows and shows the page containing the first previously displayed book if it still matches
- **AND** when deleting or refreshing leaves a page beyond the end of the results, the library shows the last valid page or the empty state

#### Scenario: Create a book and return from its editor

- **WHEN** the user creates a book from the library
- **THEN** the library clears the query and shows the page containing the created book
- **AND** when the user returns to the library from an opened book, the prior query and page are restored within the current bounds
