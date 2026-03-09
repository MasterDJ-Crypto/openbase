# OpenBase SDK Reference

This document describes the current `openbase-js` SDK surface in the monorepo.

## Installation

```bash
pnpm add openbase-js
```

## `createClient(projectUrl, anonKey)`

Creates and returns an `OpenBaseClient`.

```ts
import { createClient } from 'openbase-js'

const openbase = createClient('http://localhost:3001', 'your-anon-key')
```

### Parameters

- `projectUrl: string` - the OpenBase API base URL
- `anonKey: string` - the project anon key

### Returns

- `OpenBaseClient`

### Client members

- `openbase.from(table)` - creates a `QueryBuilder`
- `openbase.auth` - `AuthClient`
- `openbase.storage` - `StorageClient`
- `openbase.realtime` - `RealtimeClient`
- `openbase.channel(name)` - creates a realtime channel helper

## QueryBuilder

Created with:

```ts
const query = openbase.from('posts')
```

The query builder is awaitable and follows a Supabase-style chain API.

### `select(columns = '*', options?)`

Select rows from a table.

```ts
const { data, error } = await openbase.from('posts').select('*')
```

Use `options.count` to request a row count and `options.head` to return only the count payload.

```ts
const { count } = await openbase
  .from('posts')
  .select('*', { count: 'exact', head: true })
```

### Filter methods

#### `eq(column, value)`

```ts
await openbase.from('posts').select('*').eq('published', true)
```

#### `neq(column, value)`

```ts
await openbase.from('posts').select('*').neq('status', 'archived')
```

#### `gt(column, value)`

```ts
await openbase.from('posts').select('*').gt('views', 100)
```

#### `gte(column, value)`

```ts
await openbase.from('posts').select('*').gte('views', 100)
```

#### `lt(column, value)`

```ts
await openbase.from('posts').select('*').lt('views', 1000)
```

#### `lte(column, value)`

```ts
await openbase.from('posts').select('*').lte('views', 1000)
```

#### `like(column, pattern)`

Case-sensitive string match.

```ts
await openbase.from('posts').select('*').like('title', '%Guide%')
```

#### `ilike(column, pattern)`

Case-insensitive string match.

```ts
await openbase.from('posts').select('*').ilike('title', '%guide%')
```

#### `in(column, values)`

```ts
await openbase.from('posts').select('*').in('status', ['draft', 'published'])
```

#### `is(column, value)`

Supports `null` and boolean checks.

```ts
await openbase.from('posts').select('*').is('deleted_at', null)
```

### `order(column, options?)`

Order results by a column.

```ts
await openbase
  .from('posts')
  .select('*')
  .order('created_at', { ascending: false })
```

### `limit(count)`

Limit the number of rows returned.

```ts
await openbase.from('posts').select('*').limit(10)
```

### `range(from, to)`

Offset-based pagination helper.

```ts
await openbase.from('posts').select('*').range(0, 24)
```

### `single()`

Return a single row.

```ts
const { data, error } = await openbase
  .from('posts')
  .select('*')
  .eq('id', 'post-1')
  .single()
```

### `insert(data)`

Insert one row or an array of rows.

```ts
await openbase.from('posts').insert({
  title: 'Hello',
  published: true,
})
```

### `update(data)`

Update rows matching the applied filters.

```ts
await openbase.from('posts').update({ published: true }).eq('id', 'post-1')
```

### `delete()`

Delete rows matching the applied filters.

```ts
await openbase.from('posts').delete().eq('id', 'post-1')
```

### `upsert(data, options?)`

Insert or update depending on conflict resolution.

```ts
await openbase.from('posts').upsert(
  { id: 'post-1', title: 'Updated title' },
  { onConflict: 'id' }
)
```

## AuthClient

Available at:

```ts
openbase.auth
```

### `signUp({ email, password, metadata? })`

Registers a new user and stores the resulting session in the client.

```ts
const { data, error } = await openbase.auth.signUp({
  email: 'alice@example.com',
  password: 'super-secret-password',
  metadata: { role: 'admin' },
})
```

### `signInWithPassword({ email, password, mfa_code? })`

Signs in with email/password.

```ts
const { data, error } = await openbase.auth.signInWithPassword({
  email: 'alice@example.com',
  password: 'super-secret-password',
})
```

If MFA is enabled for the account, the response may require an MFA challenge flow. The client currently accepts `mfa_code` in this method when the backend expects it.

### `signIn({ email, password, mfa_code? })`

Alias for `signInWithPassword` for Supabase-style ergonomics.

```ts
const { data, error } = await openbase.auth.signIn({
  email: 'alice@example.com',
  password: 'super-secret-password',
})
```

### `signInWithOtp({ email })`

Sends a magic-link style sign-in email.

```ts
const { data, error } = await openbase.auth.signInWithOtp({
  email: 'alice@example.com',
})
```

### `signOut()`

Signs the current user out and clears the local session.

```ts
const { error } = await openbase.auth.signOut()
```

### `getSession()`

Returns the session currently stored in the client.

```ts
const { data, error } = await openbase.auth.getSession()
```

### `getUser()`

Fetches the current authenticated user.

```ts
const { data, error } = await openbase.auth.getUser()
```

### `refreshSession()`

Refreshes the current access token using the stored refresh token.

```ts
const { data, error } = await openbase.auth.refreshSession()
```

### `onAuthStateChange(callback)`

Registers a callback for auth session events.

```ts
const { data } = openbase.auth.onAuthStateChange((event, session) => {
  console.log(event, session)
})

data.subscription.unsubscribe()
```

### MFA methods

The SDK exposes dedicated TOTP helpers on `openbase.auth.mfa`.

#### `openbase.auth.mfa.enroll()`

Starts TOTP enrollment and returns the enrollment token, raw secret, and otpauth URI.

```ts
const { data, error } = await openbase.auth.mfa.enroll()
```

#### `openbase.auth.mfa.verify({ enrollment_token, code })`

Completes enrollment with a live authenticator code.

```ts
const { data, error } = await openbase.auth.mfa.verify({
  enrollment_token: data.enrollment_token,
  code: '123456',
})
```

#### `openbase.auth.mfa.disable()`

Removes the current user's TOTP secret and disables MFA.

```ts
const { data, error } = await openbase.auth.mfa.disable()
```

## StorageClient

Available at:

```ts
openbase.storage
```

### `createBucket(name, options?)`

Creates a storage bucket.

```ts
const { data, error } = await openbase.storage.createBucket('avatars', {
  public: false,
})
```

### `from(bucket)`

Returns a bucket-scoped storage client.

```ts
const avatars = openbase.storage.from('avatars')
```

### `upload(path, file, options?)`

Uploads a file into the bucket.

```ts
const file = new Blob(['hello world'], { type: 'text/plain' })

const { data, error } = await openbase
  .storage
  .from('avatars')
  .upload('users/alice.txt', file)
```

### `download(path, options?)`

Downloads a file.

```ts
const { data, error } = await openbase
  .storage
  .from('avatars')
  .download('users/alice.txt')
```

`download()` supports optional image transform parameters through `options.transform`.

### `list(prefix?)`

Lists files in a bucket or under a prefix.

```ts
const { data, error } = await openbase
  .storage
  .from('avatars')
  .list('users/')
```

### Delete files: `remove(paths)`

The current SDK method name is `remove`, not `delete`.

```ts
const { data, error } = await openbase
  .storage
  .from('avatars')
  .remove(['users/alice.txt'])
```

### `getPublicUrl(path)`

Returns a direct public URL object for the file path.

```ts
const { data } = openbase
  .storage
  .from('avatars')
  .getPublicUrl('users/alice.txt')
```

### `createSignedUrl(path, expiresIn)`

Creates a signed URL.

```ts
const { data, error } = await openbase
  .storage
  .from('avatars')
  .createSignedUrl('users/alice.txt', 3600)
```

## RealtimeClient

Available at:

```ts
openbase.realtime
```

or through:

```ts
openbase.channel('posts')
```

### `channel(name)`

Creates a realtime channel helper.

```ts
const channel = openbase.channel('posts')
```

### Subscribe to table changes

Use `.on('postgres_changes', filter, callback).subscribe()` on a realtime channel for the Supabase-style API.

```ts
const subscription = openbase
  .channel('posts-feed')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'posts',
  }, payload => {
    console.log('insert', payload.new)
  })
  .subscribe()
```

Legacy event names are also supported:

```ts
const subscription = openbase
  .channel('posts')
  .on('INSERT', 'posts', payload => {
    console.log('insert', payload.new)
  })
  .on('UPDATE', 'posts', payload => {
    console.log('update', payload.new)
  })
  .on('DELETE', 'posts', payload => {
    console.log('delete', payload.old)
  })
  .subscribe()
```

### Broadcast

Receive broadcast events:

```ts
openbase
  .channel('editor-room')
  .onBroadcast(message => {
    console.log(message)
  })
  .subscribe()
```

Send a broadcast event:

```ts
openbase.channel('editor-room').send('cursor:moved', {
  userId: 'alice',
  x: 120,
  y: 88,
})
```

### Presence

Subscribe to presence updates:

```ts
openbase
  .channel('presence-room')
  .onPresence(payload => {
    if (payload.event === 'sync') {
      console.log(payload.state)
      return
    }

    console.log(payload.userId, payload.status)
  })
  .subscribe()
```

Presence state is isolated per channel. Joining, leaving, and syncing one channel does not affect another.

Publish presence:

```ts
openbase.channel('presence-room').track('alice', 'online')
```

### `unsubscribe()`

The object returned by `.subscribe()` exposes:

```ts
subscription.unsubscribe()
```

## Notes

- The SDK is intentionally close to Supabase's ergonomics, but it is not a drop-in reimplementation of every Supabase feature.
- Advanced admin helpers and some higher-level convenience methods are still narrower than Supabase's full surface.
