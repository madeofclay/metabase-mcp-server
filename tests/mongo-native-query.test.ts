import { describe, it, expect, vi } from 'vitest';
import { MetabaseClient } from '../src/client/metabase-client.js';
import { addDatabaseTools } from '../src/tools/database-tools.js';
import { addCardTools } from '../src/tools/card-tools.js';

// Metabase rejects a MongoDB native query without native.collection
// (verified on analytics.clay.cl, db 34, collection hubspot_associations).

const PIPELINE = '[{"$project":{"_id":1}},{"$limit":1}]';

function clientWithSpy() {
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const post = vi.fn(async (_url: string, body: any) => ({ data: { status: 'completed', echo: body } }));
  (client as any).axiosInstance.post = post;
  return { client, post };
}

function toolsOf(register: (server: any, getClient: any) => void, client: any) {
  const tools = new Map<string, any>();
  register({ addTool: (t: any) => tools.set(t.name, t) }, () => client);
  return tools;
}

describe('MetabaseClient.executeQuery', () => {
  it('sends the collection with a MongoDB pipeline', async () => {
    const { client, post } = clientWithSpy();
    await client.executeQuery(34, PIPELINE, [], 'hubspot_associations');
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/dataset');
    expect(body.native).toMatchObject({ query: PIPELINE, collection: 'hubspot_associations' });
    expect(body.database).toBe(34);
  });

  it('leaves SQL queries as they were', async () => {
    const { client, post } = clientWithSpy();
    await client.executeQuery(40, 'SELECT 1');
    expect(post.mock.calls[0][1].native).not.toHaveProperty('collection');
  });
});

describe('execute_query tool', () => {
  it('accepts a collection and passes it through', async () => {
    const { client, post } = clientWithSpy();
    const tool = toolsOf(addDatabaseTools, client).get('execute_query');
    expect(tool.parameters.safeParse({ database_id: 34, query: PIPELINE, collection: 'hubspot_associations' }).success).toBe(true);
    await tool.execute({ database_id: 34, query: PIPELINE, collection: 'hubspot_associations' }, {});
    expect(post.mock.calls[0][1].native.collection).toBe('hubspot_associations');
  });

  it('tells the model that MongoDB needs a collection', () => {
    const { client } = clientWithSpy();
    const tool = toolsOf(addDatabaseTools, client).get('execute_query');
    expect(tool.description).toMatch(/MongoDB/);
    expect(tool.description).toMatch(/collection is required/);
  });
});

describe('create_card tool', () => {
  it('stores the collection in a MongoDB card', async () => {
    const { client } = clientWithSpy();
    const createCard = vi.fn(async (payload: any) => payload);
    (client as any).createCard = createCard;
    const tool = toolsOf(addCardTools, client).get('create_card');
    await tool.execute({ name: 'm', database_id: 34, query: PIPELINE, collection: 'hubspot_associations' }, {});
    expect(createCard.mock.calls[0][0].dataset_query.native).toEqual({ query: PIPELINE, collection: 'hubspot_associations' });
  });

  it('keeps SQL cards without a collection', async () => {
    const { client } = clientWithSpy();
    const createCard = vi.fn(async (payload: any) => payload);
    (client as any).createCard = createCard;
    const tool = toolsOf(addCardTools, client).get('create_card');
    await tool.execute({ name: 's', database_id: 40, query: 'SELECT 1' }, {});
    expect(createCard.mock.calls[0][0].dataset_query.native).toEqual({ query: 'SELECT 1' });
  });
});
