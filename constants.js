const PLUGINS = [
  { message: "Sales", name: "sales" },
  { message: "Tasks", name: "task" },
  { message: "Tickets", name: "tickets" },
  { message: "Inbox", name: "inbox" },
  { message: "Automations", name: "automations" }
];

const EXPERIENCES = [
  { message: "Sales", name: "exp1" },
  { message: "Frontline", name: "exp2" },
  { message: "Operation", name: "exp3" },
  { message: "Marketing", name: "exp4" }
];

const PLUGINS_WITH_EXPERIENCE = {
  exp1: [{ name: "sales" }, { name: "tasks" }],
  exp2: [{ name: "sales" }, { name: "tasks" }, { name: "purchases" }],
  exp3: [{ name: "sales" }, { name: "tasks" }, { name: "purchases" }],
  exp4: [{ name: "sales" }, { name: "tasks" }, { name: "purchases" }]
};

module.exports = { PLUGINS, EXPERIENCES, PLUGINS_WITH_EXPERIENCE };
