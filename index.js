"use strict";

const fs = require("fs");
const { Select, Input, MultiSelect } = require("enquirer");
const generator = require("generate-password");
const {
  EXPERIENCES,
  PLUGINS_WITH_EXPERIENCE,
  PLUGINS
} = require("./constants");

const { deployDbs, erxesUp } = require("./deployer");

const generatePass = () =>
  generator.generate({
    length: 10,
    numbers: true
  });

const installAndDeployment = async () => {
  const configs = {
    domain: "",
    jwt_token_secret: generatePass(),
    essyncer: {},
    redis: {
      password: generatePass()
    },
    installer: {},
    elasticsearch: {},
    mongo: {
      username: "erxes",
      password: generatePass(),
      replication: true
    },
    rabbitmq: {
      cookie: "",
      user: "erxes",
      pass: generatePass(),
      vhost: ""
    }
  };

  const domain = await new Input({
    message: "Please enter your domain: ",
    initial: "example.erxes.io",
    required: true
  }).run();

  const version = await new Select({
    message: "Select release: ",
    choices: ["2.0.3", "2.0.2", "2.0.1"]
  }).run();

  configs.image_tag = version;

  const installTypeSelect = new Select({
    message: "Select installation type: ",
    choices: ["Choose Experience", "Choose Plugins"]
  });

  const installType = await installTypeSelect.run();

  if (installType === "Choose Experience") {
    const experience = await new Select({
      message: "Select experience type: ",
      choices: EXPERIENCES
    }).run();

    configs.plugins = PLUGINS_WITH_EXPERIENCE[experience];
  }

  if (installType === "Choose Plugins") {
    const chosenPlugins = await new MultiSelect({
      message: "Select experience type: ",
      choices: PLUGINS
    }).run();

    configs.plugins = chosenPlugins.map(plugin => {
      return { name: plugin };
    });
  }

  await deployDbs();
  await erxesUp();

  fs.writeFileSync("configs.json", JSON.stringify(configs, null, 4));
};

const main = async () => {
  const actionSelect = new Select({
    message: "Select a Action you want to perform:",
    choices: [
      "Deployment",
      "Start",
      "Stop",
      "Restart",
      "Update",
      "View logs",
      "Backup Data"
    ]
  });

  const answer = await actionSelect.run();

  switch (answer) {
    case "Deployment":
      return installAndDeployment();
      break;
  }
};

main();
