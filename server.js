const express = require('express');
const path = require('path');
const https = require('https');
const jsforce = require('jsforce');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Salesforce Connection ──────────────────
let sfConn = null;
let sfOrgInfo = null;

async function getSfConnection() {
  if (sfConn && sfConn.accessToken) {
    try {
      await sfConn.identity();
      return sfConn;
    } catch (e) {
      sfConn = null;
      sfOrgInfo = null;
    }
  }

  const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const conn = new jsforce.Connection({ loginUrl });

  const username = process.env.SF_USERNAME;
  const password = process.env.SF_PASSWORD || '';
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const securityToken = process.env.SF_SECURITY_TOKEN || '';
  const fullPassword = password + securityToken;

  if (clientId && clientSecret && username) {
    // OAuth2 password flow
    conn.oauth2 = new jsforce.OAuth2({ loginUrl, clientId, clientSecret });
    await conn.login(username, fullPassword);
  } else if (username && fullPassword) {
    await conn.login(username, fullPassword);
  } else {
    throw new Error('No SF credentials configured');
  }

  sfConn = conn;

  // Cache org info
  const identity = await conn.identity();
  const orgDesc = await conn.query("SELECT Id, Name, OrganizationType, InstanceName FROM Organization LIMIT 1");
  sfOrgInfo = {
    orgId: identity.organization_id,
    username: identity.username,
    displayName: identity.display_name,
    instanceUrl: conn.instanceUrl,
    orgName: orgDesc.records[0]?.Name || 'Unknown',
    orgType: orgDesc.records[0]?.OrganizationType || 'Unknown',
    instance: orgDesc.records[0]?.InstanceName || 'Unknown',
    connectedAt: new Date().toISOString()
  };

  console.log('[SF] Connected to', sfOrgInfo.orgName, '(' + sfOrgInfo.orgId + ')');
  return conn;
}

// ─── Claude API Helper ──────────────────────
function callClaude(systemPrompt, userMessage, maxTokens = 4096) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_KEY;
    if (!apiKey) return reject(new Error('ANTHROPIC_KEY not configured'));

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message));
          const text = j.content?.map(b => b.text || '').join('') || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── In-Memory Task Store ───────────────────
const tasks = new Map();

// ─── Agent System Prompts ───────────────────
const AGENT_PROMPTS = {
  flows: `You are a Salesforce Flow expert agent. Given a user request and org context, generate the Flow metadata XML.
Rules:
- Use AutoLaunchedFlow or ScreenFlow as appropriate
- Reference real objects/fields from the org context provided
- Output ONLY the XML, no explanations
- Use API version 62.0`,

  apex: `You are a Salesforce Apex expert agent. Given a user request and org context, generate production-ready Apex code.
Rules:
- Follow Salesforce best practices (bulkification, SOQL limits, etc.)
- Include proper error handling
- Output ONLY the Apex code, no explanations
- Use API version 62.0`,

  validation: `You are a Salesforce Validation Rule expert. Given a user request and org context, generate the validation rule.
Rules:
- Output a JSON object with: { "objectName": "...", "fullName": "...", "active": true, "errorConditionFormula": "...", "errorMessage": "...", "errorDisplayField": "..." }
- Use real field API names from the org context
- Output ONLY the JSON, no explanations`,

  permissions: `You are a Salesforce Permission Set expert. Given a user request and org context, generate a Permission Set definition.
Rules:
- Output a JSON with: { "label": "...", "description": "...", "objectPermissions": [...], "fieldPermissions": [...] }
- Use real object and field API names from the org context
- Output ONLY the JSON, no explanations`,

  data: `You are a Salesforce Data expert. Given a user request and org context, generate SOQL queries and Apex batch code to clean/fix data.
Rules:
- First output the diagnostic SOQL query
- Then output the fix (Anonymous Apex or Batch Apex)
- Use real objects/fields from the org context
- Output code blocks with language markers`,

  docs: `You are a Salesforce Org Documentation expert. Given org metadata context, generate comprehensive documentation.
Rules:
- Document objects, fields, relationships, automations
- Use markdown format
- Be concise but thorough`,

  deploy: `You are a Salesforce Deployment expert. Given a user request, generate a deployment manifest in the Ever I9 format.
Rules:
- Output a JSON manifest with: { "specName": "...", "metadata": { "customObjects": [], "customFields": [], ... } }
- Follow the Ever I9 manifest format exactly
- Output ONLY the JSON, no explanations`
};

const AGENT_META = {
  flows: { name: 'Flow Agent', language: 'xml', type: 'Flow' },
  apex: { name: 'Apex Agent', language: 'java', type: 'ApexClass' },
  validation: { name: 'Validation Agent', language: 'json', type: 'ValidationRule' },
  permissions: { name: 'Permission Agent', language: 'json', type: 'PermissionSet' },
  data: { name: 'Data Clean Agent', language: 'sql', type: 'SOQL + Batch' },
  docs: { name: 'Docs Agent', language: 'markdown', type: 'Documentation' },
  deploy: { name: 'Deploy Agent', language: 'json', type: 'Manifest' }
};

// ─── Agent Detection ────────────────────────
function detectAgent(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes('flow') || lower.includes('automação') || lower.includes('automation') || lower.includes('fluxo')) return 'flows';
  if (lower.includes('apex') || lower.includes('trigger') || lower.includes('classe') || lower.includes('class')) return 'apex';
  if (lower.includes('validation') || lower.includes('validação') || lower.includes('regra de valid')) return 'validation';
  if (lower.includes('permiss') || lower.includes('perfil') || lower.includes('fls') || lower.includes('permission')) return 'permissions';
  if (lower.includes('limp') || lower.includes('clean') || lower.includes('dados') || lower.includes('data clean') || lower.includes('duplicat')) return 'data';
  if (lower.includes('doc') || lower.includes('document') || lower.includes('inventar')) return 'docs';
  if (lower.includes('deploy') || lower.includes('changeset') || lower.includes('manifest')) return 'deploy';
  return 'flows';
}

// ─── Routes ─────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'ever-i9-sf-agent',
    version: '1.1.0',
    sfConnected: !!sfConn,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Org Status
app.get('/api/org-status', async (req, res) => {
  try {
    await getSfConnection();
    res.json({ connected: true, ...sfOrgInfo });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// Chat — receive prompt, generate real artifact
app.post('/api/chat', async (req, res) => {
  try {
    const { message, agentType } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const detected = agentType || detectAgent(message);
    const meta = AGENT_META[detected] || AGENT_META.flows;
    const systemPrompt = AGENT_PROMPTS[detected] || AGENT_PROMPTS.flows;

    // Get org context
    let orgContext = 'Org not connected — generate generic artifact.';
    try {
      const conn = await getSfConnection();
      // Get relevant objects based on message
      const objects = extractObjectNames(message);
      const describes = [];
      for (const obj of objects.slice(0, 3)) {
        try {
          const desc = await conn.describe(obj);
          describes.push({
            name: desc.name,
            label: desc.label,
            fields: desc.fields.slice(0, 40).map(f => ({
              name: f.name, label: f.label, type: f.type,
              referenceTo: f.referenceTo?.length ? f.referenceTo : undefined
            })),
            recordTypes: desc.recordTypeInfos?.filter(rt => rt.available).map(rt => ({ name: rt.name, id: rt.recordTypeId }))
          });
        } catch (e) { /* skip invalid objects */ }
      }
      if (describes.length > 0) {
        orgContext = 'Org metadata context:\n' + JSON.stringify(describes, null, 2);
      }
    } catch (e) {
      orgContext = 'Org connection failed: ' + e.message;
    }

    // Call Claude to generate artifact
    let artifactCode;
    let usedAI = false;
    try {
      const prompt = `User request: ${message}\n\n${orgContext}`;
      artifactCode = await callClaude(systemPrompt, prompt);
      usedAI = true;
    } catch (e) {
      // Fallback to stub if Claude fails
      console.warn('[Agent] Claude fallback:', e.message);
      artifactCode = generateStubArtifact(detected, message);
    }

    const taskId = 'task_' + Date.now();
    const task = {
      taskId,
      agent: detected,
      agentName: meta.name,
      intent: message,
      status: 'pending_review',
      artifact: { type: meta.type, language: meta.language, code: artifactCode },
      validation: { passed: true, errors: [], warnings: usedAI ? [] : ['Generated without AI — stub artifact'] },
      usedAI,
      createdAt: new Date().toISOString()
    };

    tasks.set(taskId, task);
    res.json(task);
  } catch (err) {
    console.error('[Chat Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Tasks list
app.get('/api/tasks', (req, res) => {
  const list = Array.from(tasks.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ tasks: list, total: list.length });
});

// Approve
app.post('/api/approve/:id', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // TODO: real deploy via jsforce metadata API
  task.status = 'deployed';
  task.deployedAt = new Date().toISOString();
  res.json(task);
});

// Rollback
app.post('/api/rollback/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  task.status = 'rolled_back';
  task.rolledBackAt = new Date().toISOString();
  res.json(task);
});

// ─── Helpers ────────────────────────────────
function extractObjectNames(msg) {
  const known = ['Account','Contact','Lead','Opportunity','Case','Order','Quote','Contract',
    'Campaign','Product2','PricebookEntry','OpportunityLineItem','Task','Event',
    'ContentDocument','User','Asset','Network_Asset__c','Network_Coverage__c'];
  const found = known.filter(obj => msg.toLowerCase().includes(obj.toLowerCase().replace('__c','')));
  if (found.length === 0) {
    // Try to detect from context
    if (msg.toLowerCase().includes('lead')) return ['Lead'];
    if (msg.toLowerCase().includes('conta') || msg.toLowerCase().includes('account')) return ['Account'];
    if (msg.toLowerCase().includes('oportunid') || msg.toLowerCase().includes('opportunit')) return ['Opportunity'];
    if (msg.toLowerCase().includes('caso') || msg.toLowerCase().includes('case')) return ['Case'];
    if (msg.toLowerCase().includes('contato') || msg.toLowerCase().includes('contact')) return ['Contact'];
    if (msg.toLowerCase().includes('pedido') || msg.toLowerCase().includes('order')) return ['Order'];
    if (msg.toLowerCase().includes('cotaç') || msg.toLowerCase().includes('quote')) return ['Quote'];
    return ['Account', 'Lead'];
  }
  return found;
}

function generateStubArtifact(agent, message) {
  const stubs = {
    flows: `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n  <label>Stub Flow</label>\n  <status>Draft</status>\n  <!-- ${message} -->\n  <!-- STUB: Claude API unavailable -->\n</Flow>`,
    apex: `// STUB: Claude API unavailable\npublic class StubHandler {\n    // ${message}\n    public static void execute() {\n        // TODO\n    }\n}`,
    validation: `{\n  "objectName": "Account",\n  "fullName": "Stub_Rule",\n  "active": false,\n  "errorConditionFormula": "false",\n  "errorMessage": "Stub — ${message}"\n}`,
    permissions: `{\n  "label": "Stub PermSet",\n  "objectPermissions": [],\n  "fieldPermissions": []\n}`,
    data: `-- STUB: Claude API unavailable\n-- ${message}\nSELECT Id, Name FROM Account LIMIT 10`,
    docs: `# Org Documentation (Stub)\n\n${message}\n\n> Claude API unavailable`,
    deploy: `{\n  "specName": "Stub_Deploy",\n  "metadata": {}\n}`
  };
  return stubs[agent] || stubs.flows;
}

// ─── Pre-connect on startup ─────────────────
getSfConnection().then(() => {
  console.log('[SF] Pre-connected successfully');
}).catch(e => {
  console.warn('[SF] Pre-connect failed:', e.message, '— will retry on first request');
});

// ─── SPA fallback ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[SF Agent] v1.1.0 running on port ${PORT}`);
});
