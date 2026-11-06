# DBML conventions

schema-lens reads standard DBML, so an existing `.dbml` file opens without changes. Three
optional conventions add information that DBML has no syntax for: logical foreign keys,
edge labels, and clusters.

## Logical foreign keys

Some relationships are enforced by the application and have no foreign-key constraint in
the database. To mark one, put a trailing `// logical` comment on the line that declares
the `Ref`. schema-lens draws logical foreign keys as dashed lines and enforced ones as solid
lines.

```dbml
Ref: comment_reads.comment_id > comments.id // logical
Ref: repo_insights.repo_id - repos.id // logical, filled by a batch job

Table comment_mentions {
  mentioned_user_id uuid [ref: > users.id] // logical
}
```

The marker works with short `Ref:` lines, lines inside a `Ref { }` block, inline
`[ref: ...]` settings, composite refs such as `a.(x, y) > b.(x, y)`, table aliases, quoted
identifiers, and `public.` prefixes. The comment can hold other text, as long as it
contains the word `logical`.

`@dbml/core` drops comments while parsing, so schema-lens scans the raw text for these
markers before parsing. The scan skips commented-out refs, block comments, and ref-shaped
text inside `note` strings.

The delete impact view shows effects that pass through a logical foreign key apart from
the effects the database guarantees. A logical foreign key never blocks a delete there,
because the database does not enforce it.

## Edge labels

A short phrase at the start of a column note becomes the label of that column's
relationship. The label appears in tooltips and in focus mode.

```dbml
Table issues {
  assignee_id uuid [ref: > users.id, note: 'assignee → users.id']
}
```

Here the label is `assignee`. schema-lens takes the text before the first `→`, `(`, `.`,
`;`, or `,`, and uses it only if it is 2 to 14 characters long. Before that, it removes
leading version and constraint tokens such as `V79.`, `UNIQUE (...)`, and `uq_...`, so a
note like `'V79. assignee → users.id'` still yields `assignee`.

## Clusters

`TableGroup` decides which tables form a cluster in the group layout, which header color
each table card gets, and how the sidebar is grouped.

```dbml
TableGroup collaboration {
  issues
  comments
  comment_mentions
}
```

## How schema-lens reads cardinality

schema-lens shows cardinality on edge hover and in tooltips. A `-` ref or a foreign key
with a unique constraint is `1:1`, and every other foreign key is `N:1`. A table is treated
as a junction table and badged `N:M` when its composite primary key consists only of foreign
keys, or when it has two foreign keys and only a few other columns.
