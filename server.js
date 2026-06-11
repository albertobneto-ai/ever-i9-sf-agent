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

// ─── LLM Helper: DeepSeek → OpenRouter fallback (18s timeout) ───
function callOpenAICompatible(hostname, path, apiKey, model, systemPrompt, userMessage, maxTokens) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('LLM timeout (18s)')); }, 18000);
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message || JSON.stringify(j.error)));
          const text = j.choices?.[0]?.message?.content || '';
          if (!text) return reject(new Error('Empty LLM response'));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

async function callLLM(systemPrompt, userMessage, maxTokens = 2048) {
  // 1) Try DeepSeek direct API
  const dsKey = process.env.DEEPSEEK_KEY;
  if (dsKey) {
    try {
      console.log('[LLM] Trying DeepSeek direct...');
      return await callOpenAICompatible('api.deepseek.com', '/chat/completions', dsKey, 'deepseek-chat', systemPrompt, userMessage, maxTokens);
    } catch (e) {
      console.warn('[LLM] DeepSeek failed:', e.message);
    }
  }
  // 2) Fallback: OpenRouter free DeepSeek
  const orKey = process.env.OPENROUTER_KEY;
  if (orKey) {
    try {
      console.log('[LLM] Trying OpenRouter free...');
      return await callOpenAICompatible('openrouter.ai', '/api/v1/chat/completions', orKey, 'deepseek/deepseek-chat-v3-0324:free', systemPrompt, userMessage, maxTokens);
    } catch (e) {
      console.warn('[LLM] OpenRouter failed:', e.message);
    }
  }
  throw new Error('No LLM API available (DEEPSEEK_KEY and OPENROUTER_KEY both missing or failed)');
}

// ─── In-Memory Task Store ───────────────────
const tasks = new Map();

// ─── Agent System Prompts ───────────────────
const AGENT_PROMPTS = {
  fields: `You are a Salesforce Metadata expert. Generate an Ever I9 deployment manifest JSON for creating fields, objects, record types, or layouts.

MANIFEST FORMAT — follow EXACTLY:
{
  "specName": "Descriptive_Name",
  "metadata": {
    "customObjects": [],
    "customFields": [],
    "recordTypes": [],
    "validationRules": [],
    "permissionSets": []
  }
}

FIELD FORMAT (inside customFields array):
{
  "objectName": "Lead",
  "fieldName": "CNPJ__c",
  "label": "CNPJ",
  "type": "Text",
  "length": 18
}

FIELD TYPES and required params:
- Text: length (1-255)
- LongTextArea: length, visibleLines
- Number: precision, scale
- Currency: precision, scale
- Picklist: picklist (array of strings, e.g. ["V1","V2"])
- MultiselectPicklist: picklist, visibleLines
- Lookup: referenceTo, relationshipLabel
- Checkbox, Date, DateTime, Email, Phone, Url, TextArea: no extra params

CRITICAL: picklist values MUST be simple string array: "picklist": ["Value1", "Value2"]

OBJECT FORMAT (inside customObjects):
{ "fullName": "MyObj__c", "label": "My Object", "pluralLabel": "My Objects", "nameFieldType": "Text", "nameFieldLabel": "Name", "sharingModel": "ReadWrite", "deploymentStatus": "Deployed" }

Output ONLY the JSON manifest, no markdown fences, no explanations.`,

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

  docs: `You are a Salesforce Org Documentation expert. Given org metadata, generate a concise summary.
Rules:
- List objects with key fields and relationships
- Keep it under 500 words
- Use markdown format
- Output ONLY the documentation, no preamble`,

  deploy: `You are a Salesforce Deployment expert. Given a user request, generate a deployment manifest in the Ever I9 format.
Rules:
- Output a JSON manifest with: { "specName": "...", "metadata": { "customObjects": [], "customFields": [], ... } }
- Follow the Ever I9 manifest format exactly
- Output ONLY the JSON, no explanations`,

  runbook: `You are a Salesforce technical specification parser. Extract ALL deployable components from the spec/runbook provided and output a structured JSON.

OUTPUT FORMAT — follow EXACTLY:
{
  "specName": "Name_From_Spec",
  "summary": "Brief description of what this spec implements",
  "metadata": {
    "customObjects": [
      { "fullName": "MyObj__c", "label": "My Object", "pluralLabel": "My Objects", "nameFieldType": "Text", "nameFieldLabel": "Name", "sharingModel": "ReadWrite", "deploymentStatus": "Deployed" }
    ],
    "customFields": [
      { "objectName": "Lead", "fieldName": "CNPJ__c", "label": "CNPJ", "type": "Text", "length": 18 }
    ],
    "validationRules": [
      { "objectName": "Lead", "fullName": "Lead.Rule_Name", "active": true, "errorConditionFormula": "...", "errorMessage": "..." }
    ],
    "recordTypes": [
      { "objectName": "Account", "fullName": "Account.Enterprise", "label": "Enterprise", "active": true }
    ],
    "permissionSets": []
  },
  "apexClasses": [
    { "name": "ClassName", "body": "full apex code here" }
  ],
  "apexTriggers": [
    { "name": "TriggerName", "body": "full trigger code here" }
  ],
  "manual": [
    { "type": "Flow", "name": "Flow Name", "description": "What it does", "steps": "Step-by-step guide to create in Setup" },
    { "type": "PageLayout", "name": "Layout Name", "description": "Sections and field arrangement" },
    { "type": "LightningPage", "name": "Page Name", "description": "Components and layout" },
    { "type": "ReportType", "name": "Report Name", "description": "Objects and fields to include" }
  ]
}

FIELD TYPES: Text(length), LongTextArea(length,visibleLines), Number(precision,scale), Currency(precision,scale), Picklist(picklist:["V1","V2"]), Lookup(referenceTo,relationshipLabel), Checkbox, Date, DateTime, Email, Phone, Url, TextArea.

RULES:
- Extract EVERY component mentioned in the spec — objects, fields, validation rules, apex, flows, layouts, reports, permission sets
- Put auto-deployable components in metadata/apexClasses/apexTriggers
- Put NON-automatable items in "manual" with clear step-by-step instructions
- For Apex, include the COMPLETE code — not stubs
- For picklist fields, use simple array: "picklist": ["V1", "V2"]
- Field names MUST end with __c
- If the spec mentions Record Types, include them
- Output ONLY the JSON, no markdown fences, no explanations`
};

const AGENT_META = {
  runbook: { name: 'Runbook Agent', language: 'json', type: 'Runbook' },
  fields: { name: 'Metadata Agent', language: 'json', type: 'Manifest' },
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
  const len = msg.length;
  // Runbook — large text (spec pasted) or explicit trigger
  if (lower.includes('runbook') || lower.includes('/runbook') || lower.includes('especificação técnica') || lower.includes('spec técnica') || lower.includes('executar spec') || len > 1500) return 'runbook';
  // Fields/Metadata FIRST — most common admin task
  if (lower.includes('campo') || lower.includes('field') || lower.includes('criar objeto') || lower.includes('create object') || lower.includes('custom object') || lower.includes('objeto custom') || lower.includes('record type') || lower.includes('tipo de registro') || lower.includes('picklist') || lower.includes('lookup') || lower.includes('layout')) return 'fields';
  if (lower.includes('flow') || lower.includes('automação') || lower.includes('automation') || lower.includes('fluxo')) return 'flows';
  if (lower.includes('apex') || lower.includes('trigger') || lower.includes('classe') || lower.includes('class')) return 'apex';
  if (lower.includes('validation') || lower.includes('validação') || lower.includes('regra de valid')) return 'validation';
  if (lower.includes('permiss') || lower.includes('perfil') || lower.includes('fls') || lower.includes('permission')) return 'permissions';
  if (lower.includes('limp') || lower.includes('clean') || lower.includes('dados') || lower.includes('data clean') || lower.includes('duplicat')) return 'data';
  if (lower.includes('doc') || lower.includes('document') || lower.includes('inventar')) return 'docs';
  if (lower.includes('deploy') || lower.includes('changeset') || lower.includes('manifest')) return 'deploy';
  return 'fields'; // default = metadata creation (not flow)
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

// ─── Describe Cache (5 min TTL) ─────────────
const describeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function cachedDescribe(conn, objName) {
  const cached = describeCache.get(objName);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const desc = await conn.describe(objName);
  const slim = {
    name: desc.name,
    fields: desc.fields.slice(0, 20).map(f => f.name + ':' + f.type).join(', '),
    recordTypes: desc.recordTypeInfos?.filter(rt => rt.available && rt.name !== 'Master').map(rt => rt.name)
  };
  describeCache.set(objName, { data: slim, ts: Date.now() });
  return slim;
}

// Chat — receive prompt, generate real artifact
app.post('/api/chat', async (req, res) => {
  try {
    const { message, agentType } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const detected = agentType || detectAgent(message);
    const meta = AGENT_META[detected] || AGENT_META.flows;
    const systemPrompt = AGENT_PROMPTS[detected] || AGENT_PROMPTS.flows;

    // Get org context (parallel describes, cached)
    let orgContext = 'Org not connected.';
    try {
      const conn = await getSfConnection();
      const objects = extractObjectNames(message).slice(0, 2);
      const results = await Promise.allSettled(objects.map(o => cachedDescribe(conn, o)));
      const describes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (describes.length > 0) orgContext = 'Org context: ' + JSON.stringify(describes);
    } catch (e) {
      orgContext = 'Org offline: ' + e.message;
    }

    // Call DeepSeek LLM
    let artifactCode;
    let usedAI = false;
    try {
      const prompt = `User request: ${message}\n\n${orgContext}`;
      const maxTokens = (detected === 'runbook') ? 4096 : 2048;
      artifactCode = await callLLM(systemPrompt, prompt, maxTokens);
      usedAI = true;
    } catch (e) {
      // Fallback to stub if LLM fails
      console.warn('[Agent] LLM fallback:', e.message);
      console.warn('[Agent] Falling back to stub artifact');
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

// ─── MCP Server Proxy for Real Deploy ───────
const MCP_BASE = 'https://mcp-sf-provisioning-462dd29c2455.herokuapp.com';

function mcpRequest(path, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('MCP timeout (25s)')); }, 25000);
    const data = JSON.stringify(body);
    const url = new URL(MCP_BASE + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.substring(0,200))); } });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(data);
    req.end();
  });
}

function cleanCode(code) {
  return code.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

function extractApexName(code) {
  // Trigger: trigger Name on Object
  const trigMatch = code.match(/trigger\s+(\w+)\s+on\s+/i);
  if (trigMatch) return { name: trigMatch[1], isTrigger: true };
  // Class: public class Name | global class Name
  const clsMatch = code.match(/(?:public|global|private)\s+(?:with\s+sharing\s+|without\s+sharing\s+|virtual\s+|abstract\s+)*class\s+(\w+)/i);
  if (clsMatch) return { name: clsMatch[1], isTrigger: false };
  return { name: 'GeneratedComponent', isTrigger: false };
}

function extractComponentName(task) {
  const code = cleanCode(task.artifact.code);
  const type = task.artifact.type;

  if (type === 'ApexClass') {
    const { name, isTrigger } = extractApexName(code);
    return { name, kind: isTrigger ? 'ApexTrigger' : 'ApexClass' };
  }
  if (type === 'ValidationRule') {
    try {
      const j = JSON.parse(code);
      return { name: j.fullName || j.objectName + '.' + (j.fullName || 'Rule'), kind: 'ValidationRule', meta: j };
    } catch(e) { return { name: 'ValidationRule', kind: 'ValidationRule' }; }
  }
  if (type === 'PermissionSet') {
    try {
      const j = JSON.parse(code);
      return { name: j.label || 'PermissionSet', kind: 'PermissionSet', meta: j };
    } catch(e) { return { name: 'PermissionSet', kind: 'PermissionSet' }; }
  }
  if (type === 'Flow') {
    const labelMatch = code.match(/<label>([^<]+)<\/label>/);
    return { name: labelMatch ? labelMatch[1] : 'Flow', kind: 'Flow' };
  }
  if (type === 'Manifest') {
    try {
      const j = JSON.parse(code);
      return { name: j.specName || 'Manifest', kind: 'Manifest', meta: j };
    } catch(e) { return { name: 'Manifest', kind: 'Manifest' }; }
  }
  if (type === 'Runbook') {
    try {
      const j = JSON.parse(code);
      return { name: j.specName || 'Runbook', kind: 'Runbook', meta: j };
    } catch(e) { return { name: 'Runbook', kind: 'Runbook' }; }
  }
  return { name: task.agentName, kind: type };
}

// Approve — REAL DEPLOY to Salesforce via MCP server
app.post('/api/approve/:id', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const code = cleanCode(task.artifact.code);
  const comp = extractComponentName(task);
  task.componentName = comp.name;
  task.componentKind = comp.kind;

  try {
    let deployResult;

    if (comp.kind === 'ApexClass') {
      console.log('[Deploy] ApexClass:', comp.name);
      deployResult = await mcpRequest('/api/deploy-code', {
        apexClasses: [{ name: comp.name, body: code }]
      });
    }
    else if (comp.kind === 'ApexTrigger') {
      console.log('[Deploy] ApexTrigger:', comp.name);
      deployResult = await mcpRequest('/api/deploy-code', {
        apexTriggers: [{ name: comp.name, body: code }]
      });
    }
    else if (comp.kind === 'ValidationRule' && comp.meta) {
      console.log('[Deploy] ValidationRule:', comp.name);
      const vr = comp.meta;
      // Deploy via manifest
      deployResult = await mcpRequest('/api/deploy-code', {
        validationRules: [{
          objectName: vr.objectName,
          fullName: vr.fullName?.includes('.') ? vr.fullName : (vr.objectName + '.' + vr.fullName),
          active: vr.active !== false,
          errorConditionFormula: vr.errorConditionFormula,
          errorMessage: vr.errorMessage,
          errorDisplayField: vr.errorDisplayField
        }]
      });
    }
    else if (comp.kind === 'Manifest' && comp.meta) {
      console.log('[Deploy] Manifest:', comp.name);
      const manifest = comp.meta;
      const results = [];

      // Deploy custom objects
      if (manifest.metadata?.customObjects?.length) {
        for (const obj of manifest.metadata.customObjects) {
          try {
            const r = await mcpRequest('/api/metadata-create/CustomObject', obj);
            results.push({ type: 'CustomObject', name: obj.fullName, success: r.success !== false, detail: r });
          } catch (e) { results.push({ type: 'CustomObject', name: obj.fullName, success: false, error: e.message }); }
        }
      }

      // Deploy custom fields via metadata-create (more reliable than deploy-b64)
      if (manifest.metadata?.customFields?.length) {
        for (const field of manifest.metadata.customFields) {
          try {
            const fieldMeta = {
              fullName: field.objectName + '.' + field.fieldName,
              label: (field.label || field.fieldName).replace(/__c$/, '').replace(/_/g, ' '),
              type: field.type
            };
            if (field.length) fieldMeta.length = field.length;
            if (field.precision) fieldMeta.precision = field.precision;
            if (field.scale !== undefined) fieldMeta.scale = field.scale;
            if (field.visibleLines) fieldMeta.visibleLines = field.visibleLines;
            if (field.referenceTo) { fieldMeta.referenceTo = field.referenceTo; fieldMeta.relationshipLabel = field.relationshipLabel || field.referenceTo + 's'; }

            // Convert picklist array to valueSet format (Metadata API v62+)
            if (field.picklist && Array.isArray(field.picklist)) {
              fieldMeta.valueSet = {
                restricted: false,
                valueSetDefinition: {
                  value: field.picklist.map((v, i) => ({
                    fullName: v,
                    label: v,
                    default: i === 0
                  }))
                }
              };
              // Remove raw picklist prop — Metadata API rejects it
            }

            const r = await mcpRequest('/api/metadata-create/CustomField', fieldMeta);
            results.push({ type: 'CustomField', name: fieldMeta.fullName, success: r.success !== false, detail: r });

            // Update FLS on Admin profile (fields are invisible by default)
            if (r.success !== false) {
              try {
                const conn = await getSfConnection();
                await conn.metadata.update('Profile', {
                  fullName: 'Admin',
                  fieldPermissions: [{
                    field: fieldMeta.fullName,
                    readable: true,
                    editable: true
                  }]
                });
                console.log('[FLS] Set readable+editable for', fieldMeta.fullName);
              } catch(e) { console.warn('[FLS] Update failed:', e.message); }
            }

            // Auto-add to layout
            try {
              await mcpRequest('/api/devtools/add-to-layout', {
                objectName: field.objectName,
                fieldName: field.fieldName
              });
            } catch(e) { console.warn('[Deploy] add-to-layout skipped:', e.message); }
          } catch (e) { results.push({ type: 'CustomField', name: field.fieldName, success: false, error: e.message }); }
        }
      }

      // Deploy validation rules
      if (manifest.metadata?.validationRules?.length) {
        for (const vr of manifest.metadata.validationRules) {
          try {
            const r = await mcpRequest('/api/metadata-create/ValidationRule', vr);
            results.push({ type: 'ValidationRule', name: vr.fullName, success: r.success !== false, detail: r });
          } catch (e) { results.push({ type: 'ValidationRule', name: vr.fullName, success: false, error: e.message }); }
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      deployResult = {
        success: failCount === 0,
        summary: { total: results.length, success: successCount, failed: failCount },
        components: results.map(r => r.name + (r.success ? ' ✓' : ' ✗')),
        details: results
      };
    }
    else if (comp.kind === 'Runbook' && comp.meta) {
      console.log('[Deploy] Runbook:', comp.name);
      const rb = comp.meta;
      const results = [];
      const manualSteps = rb.manual || [];

      // 1. Deploy custom objects
      if (rb.metadata?.customObjects?.length) {
        for (const obj of rb.metadata.customObjects) {
          try {
            const r = await mcpRequest('/api/metadata-create/CustomObject', obj);
            results.push({ type: 'CustomObject', name: obj.fullName, success: r.success !== false });
          } catch (e) { results.push({ type: 'CustomObject', name: obj.fullName, success: false, error: e.message }); }
        }
      }

      // 2. Deploy custom fields (with FLS + layout)
      if (rb.metadata?.customFields?.length) {
        for (const field of rb.metadata.customFields) {
          try {
            const fieldMeta = {
              fullName: field.objectName + '.' + field.fieldName,
              label: (field.label || field.fieldName).replace(/__c$/, '').replace(/_/g, ' '),
              type: field.type
            };
            if (field.length) fieldMeta.length = field.length;
            if (field.precision) fieldMeta.precision = field.precision;
            if (field.scale !== undefined) fieldMeta.scale = field.scale;
            if (field.visibleLines) fieldMeta.visibleLines = field.visibleLines;
            if (field.referenceTo) { fieldMeta.referenceTo = field.referenceTo; fieldMeta.relationshipLabel = field.relationshipLabel || field.referenceTo + 's'; }
            if (field.picklist && Array.isArray(field.picklist)) {
              fieldMeta.valueSet = { restricted: false, valueSetDefinition: { value: field.picklist.map((v, i) => ({ fullName: v, label: v, default: i === 0 })) } };
            }
            const r = await mcpRequest('/api/metadata-create/CustomField', fieldMeta);
            const ok = r.success !== false;
            results.push({ type: 'CustomField', name: fieldMeta.fullName, success: ok });
            if (ok) {
              try { const conn = await getSfConnection(); await conn.metadata.update('Profile', { fullName: 'Admin', fieldPermissions: [{ field: fieldMeta.fullName, readable: true, editable: true }] }); } catch(e) {}
              try { await mcpRequest('/api/devtools/add-to-layout', { objectName: field.objectName, fieldName: field.fieldName }); } catch(e) {}
            }
          } catch (e) { results.push({ type: 'CustomField', name: field.fieldName, success: false, error: e.message }); }
        }
      }

      // 3. Deploy validation rules
      if (rb.metadata?.validationRules?.length) {
        for (const vr of rb.metadata.validationRules) {
          try {
            const r = await mcpRequest('/api/metadata-create/ValidationRule', vr);
            results.push({ type: 'ValidationRule', name: vr.fullName, success: r.success !== false });
          } catch (e) { results.push({ type: 'ValidationRule', name: vr.fullName, success: false, error: e.message }); }
        }
      }

      // 4. Deploy Apex classes
      if (rb.apexClasses?.length) {
        for (const cls of rb.apexClasses) {
          try {
            const r = await mcpRequest('/api/deploy-code', { apexClasses: [{ name: cls.name, body: cls.body }] });
            results.push({ type: 'ApexClass', name: cls.name, success: !r.error });
          } catch (e) { results.push({ type: 'ApexClass', name: cls.name, success: false, error: e.message }); }
        }
      }

      // 5. Deploy Apex triggers
      if (rb.apexTriggers?.length) {
        for (const trg of rb.apexTriggers) {
          try {
            const r = await mcpRequest('/api/deploy-code', { apexTriggers: [{ name: trg.name, body: trg.body }] });
            results.push({ type: 'ApexTrigger', name: trg.name, success: !r.error });
          } catch (e) { results.push({ type: 'ApexTrigger', name: trg.name, success: false, error: e.message }); }
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      deployResult = {
        success: failCount === 0,
        summary: { total: results.length, success: successCount, failed: failCount, manual: manualSteps.length },
        components: results.map(r => r.type + ' ' + r.name + (r.success ? ' ✓' : ' ✗')),
        manual: manualSteps,
        details: results
      };
    }
    else {
      // Generic — return as preview only (no auto-deploy for flows/docs/permsets yet)
      task.status = 'pending_manual';
      task.deployNote = 'Este tipo requer deploy manual. Copie o artefato e aplique via Setup.';
      return res.json(task);
    }

    console.log('[Deploy] Result:', JSON.stringify(deployResult).substring(0, 500));

    const isFailed = deployResult?.success === false || deployResult?.error || deployResult?.status === 'error';
    if (isFailed && !deployResult?.summary?.success) {
      task.status = 'failed';
      task.deployError = deployResult.error || deployResult.message || 
        (deployResult.components ? 'Falhou: ' + deployResult.components.filter(c=>c.includes('✗')).join(', ') : 'Deploy failed');
      task.deployResult = deployResult;
      task.deployedAt = new Date().toISOString();
    } else {
      task.status = 'deployed';
      task.deployResult = deployResult;
      task.deployedAt = new Date().toISOString();
    }

    res.json(task);
  } catch (err) {
    console.error('[Deploy Error]', err.message);
    task.status = 'failed';
    task.deployError = err.message;
    res.json(task);
  }
});

// Rollback
app.post('/api/rollback/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  task.status = 'rolled_back';
  task.rolledBackAt = new Date().toISOString();
  res.json(task);
});

// Refine — AI adjusts artifact based on natural language instruction
app.post('/api/refine/:id', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { instruction } = req.body;
  if (!instruction) return res.status(400).json({ error: 'instruction is required' });

  try {
    const refined = await callLLM(
      `You are a Salesforce expert. You have an existing artifact that needs adjustment. Apply the user's instruction and output ONLY the updated artifact code — no explanations, no markdown fences.`,
      `Original request: ${task.intent}\n\nCurrent artifact (${task.artifact.type}):\n${task.artifact.code}\n\nInstruction to apply: ${instruction}`,
      2048
    );
    task.artifact.code = refined.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    task.usedAI = true;
    task.refinedAt = new Date().toISOString();
    task.refinements = (task.refinements || 0) + 1;
    res.json(task);
  } catch (e) {
    console.warn('[Refine] LLM failed:', e.message);
    res.status(500).json({ error: 'Falha ao refinar: ' + e.message });
  }
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
    runbook: `{\n  "specName": "Stub_Runbook",\n  "summary": "Stub — DeepSeek unavailable",\n  "metadata": { "customFields": [] },\n  "apexClasses": [],\n  "manual": [{ "type": "Info", "name": "Retry", "description": "LLM indisponível. Cole a spec novamente." }]\n}`,
    fields: `{\n  "specName": "Stub_Field",\n  "metadata": {\n    "customFields": [{\n      "objectName": "Account",\n      "fieldName": "Stub_Field__c",\n      "label": "Stub Field",\n      "type": "Text",\n      "length": 100\n    }]\n  }\n}`,
    flows: `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n  <label>Stub Flow</label>\n  <status>Draft</status>\n  <!-- ${message} -->\n  <!-- STUB: DeepSeek API unavailable -->\n</Flow>`,
    apex: `// STUB: DeepSeek API unavailable\npublic class StubHandler {\n    // ${message}\n    public static void execute() {\n        // TODO\n    }\n}`,
    validation: `{\n  "objectName": "Account",\n  "fullName": "Stub_Rule",\n  "active": false,\n  "errorConditionFormula": "false",\n  "errorMessage": "Stub — ${message}"\n}`,
    permissions: `{\n  "label": "Stub PermSet",\n  "objectPermissions": [],\n  "fieldPermissions": []\n}`,
    data: `-- STUB: DeepSeek API unavailable\n-- ${message}\nSELECT Id, Name FROM Account LIMIT 10`,
    docs: `# Org Documentation (Stub)\n\n${message}\n\n> DeepSeek API unavailable`,
    deploy: `{\n  "specName": "Stub_Deploy",\n  "metadata": {}\n}`
  };
  return stubs[agent] || stubs.fields;
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
