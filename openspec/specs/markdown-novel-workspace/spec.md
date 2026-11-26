# Markdown Novel Workspace Specification

## Purpose

规范个人书库及小说基本信息、主体、伏笔、全书大纲与章节的编辑体验。Markdown 是可重建的唯一稿件来源，不依赖模型或数据库。

## Requirements

### Requirement: Personal library and novel creation
书库 SHALL 展示个人作品，提供新建、打开编辑和直接硬删除。新建弹窗 SHALL 要求小说名与简介，允许选填题材和文风，不显示作者、语言、一句话前提、目标读者或独立语调字段。V1 SHALL 省略「其他」入口、导入和归档。

#### Scenario: Create a novel with required fields only
- **WHEN** 用户填写非空小说名和简介，留空题材与文风并创建
- **THEN** 作品出现在个人书库，点击「编辑」能打开该作品，即使尚未配置任何模型

#### Scenario: Reject incomplete creation
- **WHEN** 用户未填写小说名或简介，或仅填写空白字符
- **THEN** 弹窗显示对应校验信息，书库和磁盘上不产生该作品

#### Scenario: Hard-delete a novel
- **WHEN** 用户在书库点击删除且作品可删除
- **THEN** 系统不弹确认或移入归档，移除作品目录和书库条目，重启后也不显示该作品

### Requirement: Library search and editable basic information
书库 SHALL 按小说名和文件中已有的作者元数据做部分匹配，不匹配题材，不为无作者作品捏造作者信息。小说工作区 SHALL 提供「基本信息」，可修改并保存小说名、简介、题材和文风。未保存表单在应用内切页时须保留；收到不同文件指纹时显示冲突，不自动重置或覆盖。

#### Scenario: Search title or existing author but not genre
- **WHEN** 用户用一个词的片段查询，且该词分别出现在三个作品的书名、已有作者和题材中
- **THEN** 对应词片段可以匹配书名或已有作者，仅在题材中出现的匹配词不使作品命中

#### Scenario: Save and reopen basic information without a model
- **WHEN** 未配置模型的用户修改基本信息并保存，然后关闭并重新打开应用和作品
- **THEN** 书库使用新书名，基本信息显示保存后的内容，作品身份和引用未改变

#### Scenario: Preserve unsaved basic information on a background update
- **WHEN** 作者改了书名或简介但未保存，后台更新同一份基本信息文件
- **THEN** 系统保留表单输入和原始文件指纹，提示冲突并阻止覆盖；作者可复制草稿或选择重载磁盘版本

### Requirement: Story assets and whole-book outline
工作区 SHALL 提供「基本信息」「主体」「伏笔」「大纲」「章节」，并将 Session 历史留在 Harness。用户 SHALL 能在主体区列出、查看、新建、更新、硬删除有名字和说明的人物、物品或场景；能在伏笔区管理多条伏笔，并关联主体及埋设和回收章节；能读写一份全书大纲。

#### Scenario: Edit asset types and linked foreshadowing
- **WHEN** 用户建立人物、物品、场景和两条伏笔，将其中一条关联物品与现有章节，再编辑组内主体和全书大纲
- **THEN** 列表按类别显示主体，两个伏笔分别可见且关系可查，重新打开仍可读取保存后的名称、说明、关系和大纲

### Requirement: Chapter list and Markdown body editor
用户 SHALL 能在章节列表新建、查找、打开、改名、排序和硬删除章节。选中章节 SHALL 直接进入可显式保存的 Markdown 编辑区域，不要求在修订、定稿或名为「章节正文」的独立表单中操作。切换章节或页面 SHALL 在当前应用生命周期内保留未保存的正文缓冲。

#### Scenario: Persist chapter text, name and order
- **WHEN** 用户新建两章，编辑正文并保存，按标题片段查找，改名并调换顺序，再重新打开作品
- **THEN** 列表保留修改后的标题和顺序，选中的章节仍有原 Markdown 正文，章节身份不因改名或排序改变

#### Scenario: Switch away with unsaved text
- **WHEN** 用户输入正文但未保存，查看另一资产或返回书库后再回到原章
- **THEN** 编辑器保留未保存文本，磁盘未把未保存输入当作已提交正文

#### Scenario: Delete the selected chapter
- **WHEN** 用户在章节列表删除已选章节
- **THEN** 文件实际移除，列表和选中状态更新，不弹删除确认，也不因编辑器仍曾打开该章而自动重建

### Requirement: Markdown is authoritative and identities are stable
作品信息、主体、伏笔、全书大纲和章节正文 SHALL 由用户可直接访问的 UTF-8 Markdown 文件持久化。结构化关联 SHALL 使用稳定身份，界面和工具 SHALL 从文件重建列表和引用，不依赖数据库或另一套稿件数据。读不到或不能解析的文件 SHALL 得到局部错误，原始文件不因读取失败被覆盖。

#### Scenario: Rebuild from files alone
- **WHEN** 用新的应用状态打开原有 Markdown 作品库
- **THEN** 无需 Session 历史、模型配置或数据库，即可按文件重建书库、作品、资产、章节顺序和明确关联

#### Scenario: Malformed metadata in one document
- **WHEN** 一个作品的某份资产被外部编辑成无法解析的元数据
- **THEN** 该文件有可定位的错误，原始内容保留，其他正常文档和作品仍可打开

### Requirement: Deterministic reference maintenance for managed writes
应用内保存与管理式工具写入 SHALL 共用引用规则。对受影响的结构化引用进行校验；硬删除主体、伏笔或章节时解除指向已删目标的明确引用，不删除无关文件、不靠同名词改写自由正文。手工编辑 SHALL 不依赖模型做这些检查。多文件操作若只完成一部分 SHALL 报出已提交与未提交项，并按实际磁盘刷新。

#### Scenario: Removing a linked chapter does not remove the foreshadowing
- **WHEN** 用户硬删除一个伏笔关联的回收章节，另有相关主体、埋设章节和大纲中文字仍存在
- **THEN** 明确指向删除目标的引用被解除，伏笔、埋设关系、其他文件和自由文本保留

#### Scenario: Reject an invalid explicit link before writing
- **WHEN** 应用内更新尝试把伏笔回收点设为不存在的章节
- **THEN** 操作报告无效引用，不提交这项更新

#### Scenario: File replacement fails partway through a batch
- **WHEN** 多文件操作中后续文件写入失败且此前已有提交
- **THEN** 界面和调用方获得真实的部分写入结果，重新读取磁盘后显示实际内容，不报告整体成功

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
