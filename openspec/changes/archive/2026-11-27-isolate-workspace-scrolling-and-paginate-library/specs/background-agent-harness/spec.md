## ADDED Requirements

### Requirement: Independent Harness viewport scrolling

Harness SHALL fit in its column below the application top bar. The message feed and the session list SHALL each provide native vertical scrolling when their content overflows. The composer and its send action SHALL remain reachable in the minimum supported window with a conversation open. Wheel input and scrollbar dragging in the feed or session list SHALL leave the workspace and the Writer root document at their current positions.

#### Scenario: Read a long conversation in a short window

- **WHEN** Harness displays a long conversation next to an open workspace and the window is resized to its minimum supported size
- **THEN** the user can scroll the feed to older and newer messages without moving the workspace, and can still reach the message input and send action, including with multiple attachments

#### Scenario: Browse a long session list

- **WHEN** the user opens the session list and it exceeds the panel height
- **THEN** the user can scroll the list to the last session while the Harness header controls remain visible

#### Scenario: Receive messages while reviewing older history

- **WHEN** new messages arrive while the user is reading above the message feed's follow threshold
- **THEN** the feed preserves the user's reading position, and it continues following new messages when the user returns to the end
