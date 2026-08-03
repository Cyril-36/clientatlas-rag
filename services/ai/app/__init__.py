"""ClientAtlas model service.

This package parses documents, embeds text and generates tokens. It holds no
database credentials and runs no tenant query — the Next.js application owns
every tenant-scoped statement, including the pgvector search. Keeping the RLS
transaction contract in one language means there is one implementation to get
right and one suite of cross-tenant tests to trust.

Nothing in this package may be given a tenant database connection.
"""

__version__ = "0.1.0"
