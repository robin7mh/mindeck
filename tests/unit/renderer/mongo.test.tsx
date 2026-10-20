import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'

const m = vi.hoisted(() => ({
  models: [] as { value: string; disposed: boolean; listeners: ((e: unknown) => void)[]; setValue: (v: string) => void }[],
  commands: [] as (() => void)[],
  editors: 0,
  disposed: 0
}))
vi.mock('@/features/editor/components/CodeEditor', () => ({ default: () => <div data-testid="monaco" /> }))
vi.mock('@/features/editor/components/DiffView', () => ({ default: () => <div data-testid="diff" /> }))
vi.mock('@/features/editor/monaco/setup', () => ({
  THEME: 'mindeck',
  applyMonacoTheme: vi.fn(),
  monaco: {
    Uri: { parse: (s: string) => ({ s }) },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    editor: {
      createModel: (value: string) => {
        const model = {
          value,
          disposed: false,
          listeners: [] as ((e: unknown) => void)[],
          getValue: () => model.value,
          setValue: (v: string) => ((model.value = v), model.listeners.forEach((l) => l({}))),
          onDidChangeContent: (l: (e: unknown) => void) => (model.listeners.push(l), { dispose: () => {} }),
          dispose: () => (model.disposed = true)
        }
        m.models.push(model)
        return model
      },
      create: () => {
        m.editors += 1
        return { addCommand: (_k: number, fn: () => void) => m.commands.push(fn), focus: () => {}, dispose: () => (m.disposed += 1) }
      }
    }
  }
}))

import { idOf, useMongo } from '@/features/editor/mongo'
import { MongoPanel } from '@/features/editor/components/MongoPanel'
import { MongoView } from '@/features/editor/components/MongoView'
import { EditorView } from '@/features/editor/components/EditorView'
import { useEditor } from '@/features/editor/store'
import { useScm } from '@/features/editor/scm'
import { useProjects } from '@/features/projects/store'
import { de } from '@/lib/i18n/de'

const initial = useMongo.getState()
const s = () => useMongo.getState()
const CONN = { id: 'c1', name: 'Local', host: 'mongodb://localhost:27017' }
const ann = '{\n  "_id": {\n    "$oid": "a1"\n  },\n  "name": "Ann"\n}'
const bob = '{\n  "_id": 2,\n  "name": "Bob"\n}'

function mongo(over: Record<string, (p: never) => unknown> = {}) {
  return installBridge({
    'mongo:connections': () => [CONN],
    'mongo:add': ({ name }: { name: string }) => ({ id: 'c2', name: name || 'mongodb://x', host: 'mongodb://x' }),
    'mongo:remove': () => undefined,
    'mongo:databases': () => [
      { name: 'shop', sizeOnDisk: 2 * 1024 * 1024, empty: false },
      { name: 'logs', sizeOnDisk: 8192, empty: false },
      { name: 'fresh', sizeOnDisk: 0, empty: true }
    ],
    'mongo:collections': () => [
      { name: 'users', type: 'collection' },
      { name: 'active', type: 'view' }
    ],
    'mongo:find': ({ query }: { query: { skip: number } }) => ({ documents: query.skip ? [bob] : [ann, bob], total: 3 }),
    'mongo:aggregate': () => ['{"n": 2}'],
    'mongo:indexes': () => [
      { name: '_id_', key: '{"_id":1}', unique: false },
      { name: 'email_1', key: '{"email":1}', unique: true }
    ],
    'mongo:insert': () => '{"$oid":"n"}',
    'mongo:replace': () => undefined,
    'mongo:delete': () => undefined,
    'mongo:createCollection': () => undefined,
    'mongo:dropCollection': () => undefined,
    ...over
  })
}

const users = { id: 'c1', db: 'shop', collection: 'users' }

beforeEach(() => {
  useMongo.setState(initial, true)
  m.models.length = 0
  m.commands.length = 0
})

describe('MongoDB store', () => {
  it('a document’s _id as Extended JSON (none without one, none for broken text)', () => {
    expect([idOf(ann), idOf(bob), idOf('{"x": 1}'), idOf('{nope')]).toEqual(['{"$oid":"a1"}', '2', undefined, undefined])
  })

  it('connections: load, add (opens it), remove (closes what was open); errors show', async () => {
    const bridge = mongo()
    await s().load()
    expect(s().connections).toEqual([CONN])
    s().setAdding(true)
    expect(await s().add('Prod', 'mongodb://x')).toBe(true)
    expect(s()).toMatchObject({ adding: false, expanded: { c2: true } })
    expect(s().connections.map((c) => c.id)).toEqual(['c1', 'c2'])
    useMongo.setState({ open: users })
    await s().remove('c2')
    expect(s().open).toEqual(users)
    await s().remove('c1')
    expect(s()).toMatchObject({ connections: [], open: undefined })
    expect(bridge.invoke).toHaveBeenCalledWith('mongo:remove', { id: 'c1' })

    mongo({ 'mongo:connections': () => fail('locked'), 'mongo:add': () => fail('connect ECONNREFUSED'), 'mongo:remove': () => fail('gone') })
    await s().load()
    expect(s().error).toBe('locked')
    expect(await s().add('x', 'mongodb://x')).toBe(false)
    expect(s()).toMatchObject({ error: 'connect ECONNREFUSED', busy: false })
    await s().remove('c1')
    expect(s().error).toBe('gone')
    s().clearError()
    expect(s().error).toBeUndefined()
  })

  it('the tree: databases, then collections; closing; a failure closes the row again', async () => {
    mongo()
    await s().toggle('c1')
    expect(s().databases.c1.map((d) => d.name)).toEqual(['shop', 'logs', 'fresh'])
    await s().toggle('c1/shop')
    expect(s().collections['c1/shop'].map((c) => c.name)).toEqual(['users', 'active'])
    await s().toggle('c1/shop')
    expect(s().expanded).toEqual({ c1: true })
    mongo({ 'mongo:collections': () => fail('not authorized') })
    await s().toggle('c1/logs')
    expect(s()).toMatchObject({ expanded: { c1: true }, error: 'not authorized' })
  })

  it('a collection: find with filter / sort / limit and paging, aggregate, indexes; failures show', async () => {
    const bridge = mongo()
    await s().run() // nothing open
    await s().openCollection(users)
    expect(s()).toMatchObject({ documents: [ann, bob], total: 3, skip: 0, busy: false })
    s().setQuery({ filter: '{"name":"Ann"}', sort: '{"name":1}', limit: 2 })
    await s().run(2)
    expect(bridge.invoke).toHaveBeenLastCalledWith('mongo:find', { ...users, query: { filter: '{"name":"Ann"}', sort: '{"name":1}', limit: 2, skip: 2 } })
    expect(s()).toMatchObject({ documents: [bob], skip: 2 })
    await s().run() // the same page again
    expect(bridge.invoke).toHaveBeenLastCalledWith('mongo:find', expect.objectContaining({ query: expect.objectContaining({ skip: 2 }) }))

    s().setMode('aggregate')
    s().setQuery({ pipeline: '[{"$count": "n"}]' })
    await s().run()
    expect(bridge.invoke).toHaveBeenLastCalledWith('mongo:aggregate', { ...users, pipeline: '[{"$count": "n"}]' })
    expect(s()).toMatchObject({ documents: ['{"n": 2}'], total: 1, skip: 0 })
    s().setMode('indexes')
    await settle()
    expect(s().indexes.map((i) => i.name)).toEqual(['_id_', 'email_1'])
    s().setMode('find')
    await settle()
    expect(s().documents).toEqual([ann, bob])

    mongo({ 'mongo:find': () => fail("The filter isn't valid JSON") })
    await s().run()
    expect(s()).toMatchObject({ error: "The filter isn't valid JSON", busy: false })
    s().close()
    expect(s().open).toBeUndefined()
  })

  it('documents: edit (replace by _id), new (insert), delete; the list reloads; nothing without a collection', async () => {
    const bridge = mongo()
    await s().saveEdit()
    await s().deleteDocument(ann)
    expect(bridge.invoke).not.toHaveBeenCalled()
    await s().openCollection(users)
    s().setEditText('ignored') // nothing being edited
    expect(s().editing).toBeUndefined()
    s().edit(ann)
    expect(s().editing).toEqual({ docId: '{"$oid":"a1"}', text: ann })
    s().setEditText('{"name": "Ann B."}')
    await s().saveEdit()
    expect(bridge.invoke).toHaveBeenCalledWith('mongo:replace', { ...users, docId: '{"$oid":"a1"}', document: '{"name": "Ann B."}' })
    expect(s().editing).toBeUndefined()
    s().newDocument()
    expect(s().editing).toEqual({ text: '{\n  \n}' })
    s().setEditText('{"name": "Cleo"}')
    await s().saveEdit()
    expect(bridge.invoke).toHaveBeenCalledWith('mongo:insert', { ...users, document: '{"name": "Cleo"}' })
    s().newDocument()
    s().cancelEdit()
    expect(s().editing).toBeUndefined()
    await s().deleteDocument(bob)
    expect(bridge.invoke).toHaveBeenCalledWith('mongo:delete', { ...users, docId: '2' })
    bridge.invoke.mockClear()
    await s().deleteDocument('{"no": "id"}')
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it('collections: create (and open it), drop (closing it when open); failures show', async () => {
    const bridge = mongo()
    await s().createCollection('c1', 'shop', 'orders')
    expect(s().open).toEqual({ id: 'c1', db: 'shop', collection: 'orders' })
    expect(bridge.invoke).toHaveBeenCalledWith('mongo:collections', { id: 'c1', db: 'shop' })
    await s().dropCollection({ id: 'c1', db: 'shop', collection: 'other' })
    expect(s().open?.collection).toBe('orders')
    await s().dropCollection({ id: 'c1', db: 'shop', collection: 'orders' })
    expect(s().open).toBeUndefined()
    for (const [c, d] of [
      ['c2', 'shop'],
      ['c1', 'logs']
    ]) {
      useMongo.setState({ open: users })
      await s().dropCollection({ id: c, db: d, collection: 'users' })
      expect(s().open).toEqual(users)
    }
    mongo({ 'mongo:createCollection': () => fail('exists'), 'mongo:dropCollection': () => fail('denied') })
    await s().createCollection('c1', 'shop', 'x')
    expect(s().error).toBe('exists')
    await s().dropCollection(users)
    expect(s().error).toBe('denied')
  })
})

describe('databases pane', () => {
  it('without connections: what to do; adding one (connect, cancel)', async () => {
    mongo({ 'mongo:connections': () => [] })
    render(<MongoPanel />)
    await act(settle)
    expect(screen.getByText('No connections yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    const form = screen.getByRole('form', { name: 'Add connection' })
    expect(within(form).getByRole('button', { name: 'Connect' })).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Prod' } })
    fireEvent.change(within(form).getByLabelText('Connection string'), { target: { value: 'mongodb://x' } })
    expect(within(form).getByLabelText('Connection string')).toHaveAttribute('type', 'password')
    const add = vi.spyOn(useMongo.getState(), 'add').mockResolvedValue(true)
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    expect(add).toHaveBeenCalledWith('Prod', 'mongodb://x')
    act(() => useMongo.setState({ busy: true }))
    expect(within(form).getByRole('button', { name: 'Connect' })).toBeDisabled()
    act(() => useMongo.setState({ busy: false }))
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('connections → databases (sizes) → collections; opens one; new collection; delete asks first; remove', async () => {
    mongo()
    render(<MongoPanel />)
    await act(settle)
    const tree = screen.getByRole('tree', { name: 'Databases' })
    fireEvent.click(within(tree).getByRole('treeitem', { name: 'Local' }))
    expect(within(tree).getByLabelText('Loading…')).toBeInTheDocument()
    await act(settle)
    expect(within(tree).getByRole('treeitem', { name: /shop\s*2\.0 MB/ })).toBeInTheDocument()
    expect(within(tree).getByRole('treeitem', { name: /logs\s*8 KB/ })).toBeInTheDocument()
    expect(within(tree).getByRole('treeitem', { name: /fresh\s*–/ })).toBeInTheDocument()
    fireEvent.click(within(tree).getByRole('treeitem', { name: /shop/ }))
    await act(settle)
    expect(within(tree).getByRole('treeitem', { name: /active\s*view/ })).toBeInTheDocument()
    fireEvent.click(within(tree).getByRole('treeitem', { name: 'users' }))
    await act(settle)
    expect(s().open).toEqual(users)
    expect(within(tree).getByRole('treeitem', { name: 'users' })).toHaveAttribute('aria-current', 'true')

    // A new collection: named inline (Escape cancels, empty does nothing).
    const create = vi.spyOn(useMongo.getState(), 'createCollection').mockResolvedValue()
    fireEvent.click(screen.getByRole('button', { name: 'New collection (shop)' }))
    fireEvent.keyDown(screen.getByLabelText('Collection name'), { key: 'Escape' })
    expect(screen.queryByLabelText('Collection name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New collection (shop)' }))
    fireEvent.keyDown(screen.getByLabelText('Collection name'), { key: 'a' })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: ' orders ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('c1', 'shop', 'orders')

    const drop = vi.spyOn(useMongo.getState(), 'dropCollection').mockResolvedValue()
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection users' }))
    const ask = screen.getByRole('alertdialog', { name: 'Delete collection users' })
    expect(ask).toHaveTextContent('Delete users and all its documents?')
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection users' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(drop).toHaveBeenCalledWith(users)

    fireEvent.click(within(tree).getByRole('treeitem', { name: /shop/ })) // closes
    const remove = vi.spyOn(useMongo.getState(), 'remove').mockResolvedValue()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Local' }))
    expect(remove).toHaveBeenCalledWith('c1')
  })

  it('collections still loading show a spinner', async () => {
    useMongo.setState({ connections: [CONN], expanded: { c1: true, 'c1/shop': true }, databases: { c1: [{ name: 'shop', sizeOnDisk: 0, empty: true }] } })
    mongo({ 'mongo:connections': () => [CONN] })
    render(<MongoPanel />)
    expect(screen.getAllByLabelText('Loading…')).toHaveLength(1)
  })
})

describe('collection view', () => {
  it('find: filter, sort, limit, run, paging; documents edit and delete (asked first)', async () => {
    const bridge = mongo()
    await s().openCollection(users)
    render(<MongoView />)
    expect(screen.getByRole('heading', { name: 'shop.users' })).toBeInTheDocument()
    expect(screen.getByText('1–2 of 3')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: '{"a":1}' } })
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: '{"a":-1}' } })
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '5000' } })
    expect(s().limit).toBe(1000)
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '' } })
    expect(s().limit).toBe(1)
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('mongo:find', { ...users, query: { filter: '{"a":1}', sort: '{"a":-1}', limit: 2, skip: 0 } })
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await act(settle)
    expect(screen.getByText('3–3 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await act(settle)
    expect(s().skip).toBe(0)

    const del = vi.spyOn(useMongo.getState(), 'deleteDocument').mockResolvedValue()
    const doc = screen.getAllByRole('listitem')[0]
    fireEvent.click(within(doc).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(within(doc).getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(doc).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(within(doc).getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(del).toHaveBeenCalledWith(ann)
    fireEvent.click(within(doc).getByRole('button', { name: 'Edit' }))
    expect(s().editing?.docId).toBe('{"$oid":"a1"}')
  })

  it('editing in the JSON editor: typing, ⌘S or Save, Cancel; a new document', async () => {
    mongo()
    await s().openCollection(users)
    const save = vi.spyOn(useMongo.getState(), 'saveEdit').mockResolvedValue()
    render(<MongoView />)
    fireEvent.click(screen.getByRole('button', { name: /Insert document/ }))
    expect(await screen.findByText('New document')).toBeInTheDocument()
    // The JSON editor is loaded on demand: wait for it, not for a number of turns (slow under load).
    await waitFor(() => expect(m.models).toHaveLength(1), { timeout: 15_000 })
    expect(m.models[0].value).toBe('{\n  \n}')
    act(() => m.models[0].setValue('{"name": "Cleo"}'))
    expect(s().editing?.text).toBe('{"name": "Cleo"}')
    act(() => m.commands[0]())
    expect(save).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledTimes(2)
    act(() => useMongo.setState({ busy: true }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    act(() => useMongo.setState({ busy: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(m.models[0].disposed).toBe(true)
    act(() => s().edit(bob))
    expect(await screen.findByText('Edit document')).toBeInTheDocument()
  })

  it('aggregate and indexes; empty results; closing', async () => {
    mongo({ 'mongo:indexes': () => [] })
    await s().openCollection(users)
    render(<MongoView />)
    fireEvent.click(screen.getByRole('button', { name: 'Aggregate' }))
    expect(screen.queryByRole('button', { name: /Insert document/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: '[]' } })
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await act(settle)
    expect(screen.getByText('{"n": 2}')).toBeInTheDocument()
    expect(screen.queryByText(/of 1/)).toBeNull() // no paging for aggregations
    fireEvent.click(screen.getByRole('button', { name: 'Indexes' }))
    await act(settle)
    expect(screen.getByText('No indexes.')).toBeInTheDocument()
    act(() => useMongo.setState({ indexes: [{ name: 'email_1', key: '{"email":1}', unique: true }] }))
    expect(screen.getByText('unique')).toBeInTheDocument()
    act(() => useMongo.setState({ mode: 'find', documents: [], total: 0, skip: 0 }))
    expect(screen.getByText('No documents.')).toBeInTheDocument()
    expect(screen.getByText('0–0 of 0')).toBeInTheDocument()
    act(() => useMongo.setState({ busy: true }))
    expect(screen.queryByText('No documents.')).toBeNull()
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(s().open).toBeUndefined()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('speaks German', () => {
    expect([de.mongo.remove('X'), de.mongo.drop('u'), de.mongo.confirmDrop('u'), de.mongo.range(1, 2, 3)]).toEqual(['X entfernen', 'Collection u löschen', 'u mit allen Dokumenten löschen?', '1–2 von 3'])
  })
})

describe('databases in the editor', () => {
  it('the pane opens a collection in the editor area; its errors show in a banner', async () => {
    mongo({
      'files:list': () => [],
      'files:stat': () => [],
      'scm:status': () => ({ repo: false, ahead: 0, behind: 0, merging: false, files: [] }),
      'debug:session': () => null,
      'liveServer:status': () => []
    })
    useEditor.setState({ projectId: 'p' })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    const nav = screen.getByRole('navigation', { name: 'Editor' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Databases' }))
    await act(settle)
    await act(() => s().openCollection(users))
    expect(screen.getByRole('heading', { name: 'shop.users' })).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: 'Explorer' }))
    expect(screen.queryByRole('heading', { name: 'shop.users' })).toBeNull()
    act(() => useMongo.setState({ error: 'not authorized' }))
    expect(screen.getByText('not authorized')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    expect(screen.queryByText('not authorized')).toBeNull()
    useScm.getState().setPane('files')
  })
})
