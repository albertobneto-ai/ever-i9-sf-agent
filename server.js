const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ─────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'ever-i9-sf-agent',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ─── Chat — recebe prompt do usuário ────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, agentType } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    // TODO: integrar Claude API + jsforce para interpretar intent
    // Por agora, retorna stub estruturado
    const agents = {
      flows: { name: 'Flow Agent', icon: '⚡' },
      apex: { name: 'Apex Agent', icon: '💻' },
      validation: { name: 'Validation Agent', icon: '✅' },
      permissions: { name: 'Permission Agent', icon: '🔒' },
      data: { name: 'Data Clean Agent', icon: '🧹' },
      docs: { name: 'Docs Agent', icon: '📄' },
      deploy: { name: 'Deploy Agent', icon: '🚀' }
    };

    const detected = agentType || detectAgent(message);
    const agent = agents[detected] || agents.flows;

    res.json({
      taskId: `task_${Date.now()}`,
      agent: detected,
      agentName: agent.name,
      intent: message,
      status: 'pending_review',
      artifact: generateStubArtifact(detected, message),
      validation: { passed: true, errors: [], warnings: [] },
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tasks — lista tarefas pendentes ────────
app.get('/api/tasks', (req, res) => {
  res.json({ tasks: [], total: 0 });
});

// ─── Approve — aprova e executa deploy ──────
app.post('/api/approve/:id', (req, res) => {
  res.json({
    taskId: req.params.id,
    status: 'deployed',
    deployResult: { success: true },
    deployedAt: new Date().toISOString()
  });
});

// ─── Rollback — restaura snapshot ───────────
app.post('/api/rollback/:id', (req, res) => {
  res.json({
    taskId: req.params.id,
    status: 'rolled_back',
    restoredAt: new Date().toISOString()
  });
});

// ─── Helpers ────────────────────────────────
function detectAgent(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes('flow') || lower.includes('automação') || lower.includes('automation')) return 'flows';
  if (lower.includes('apex') || lower.includes('trigger') || lower.includes('classe')) return 'apex';
  if (lower.includes('validation') || lower.includes('validação') || lower.includes('regra')) return 'validation';
  if (lower.includes('permiss') || lower.includes('perfil') || lower.includes('fls')) return 'permissions';
  if (lower.includes('limp') || lower.includes('clean') || lower.includes('dado') || lower.includes('data')) return 'data';
  if (lower.includes('doc') || lower.includes('document')) return 'docs';
  if (lower.includes('deploy') || lower.includes('changeset')) return 'deploy';
  return 'flows';
}

function generateStubArtifact(agent, message) {
  const stubs = {
    flows: {
      type: 'Flow',
      language: 'xml',
      code: `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n  <label>Auto-generated Flow</label>\n  <processType>AutoLaunchedFlow</processType>\n  <status>Draft</status>\n  <!-- Generated from: ${message} -->\n</Flow>`
    },
    apex: {
      type: 'ApexClass',
      language: 'java',
      code: `public class GeneratedHandler {\n    // Generated from: ${message}\n    public static void execute() {\n        // TODO: implement\n    }\n}`
    },
    validation: {
      type: 'ValidationRule',
      language: 'xml',
      code: `<ValidationRule>\n  <fullName>Auto_Validation</fullName>\n  <active>true</active>\n  <errorConditionFormula>/* ${message} */</errorConditionFormula>\n  <errorMessage>Validation failed</errorMessage>\n</ValidationRule>`
    },
    permissions: {
      type: 'PermissionSet',
      language: 'json',
      code: JSON.stringify({ label: 'Generated PermSet', objectPermissions: [], fieldPermissions: [] }, null, 2)
    },
    data: {
      type: 'SOQL + Batch',
      language: 'sql',
      code: `-- Data cleanup query\n-- Source: ${message}\nSELECT Id, Name FROM Account WHERE Name = null`
    },
    docs: {
      type: 'Documentation',
      language: 'markdown',
      code: `# Org Documentation\n\nGenerated from: ${message}`
    },
    deploy: {
      type: 'Changeset',
      language: 'json',
      code: JSON.stringify({ components: [], status: 'ready' }, null, 2)
    }
  };
  return stubs[agent] || stubs.flows;
}

// ─── SPA fallback ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[SF Agent] Running on port ${PORT}`);
});
