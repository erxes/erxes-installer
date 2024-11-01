const fs = require("fs");
const fse = require("fs-extra");
const yaml = require("yaml");
// const ora = require("ora");
const { log, execCommand, filePath, execCurl } = require("./utils");
// const { exec } = require("child_process");

require("dotenv").config();

const {
  DEPLOYMENT_METHOD,
  SERVICE_INTERNAL_PORT = 80,
  GATEWAY_PORT = 3300,
  UI_PORT = 3000,
  MONGO_PORT = 27017,
  REDIS_PORT = 6379,
  RABBITMQ_PORT = 5672
} = process.env;

const isSwarm = DEPLOYMENT_METHOD !== "docker-compose";

const buildPlugins = ["dev", "staging", "v2", "rc", "master"];

const commonEnvs = configs => {
  const enabledServices = (configs.plugins || []).map(plugin => plugin.name);
  const be_env = configs.be_env || {};
  enabledServices.push("workers");
  const enabledServicesJson = JSON.stringify(enabledServices);

  const db_server_address = configs.db_server_address;
  const widgets = configs.widgets || {};
  const redis = configs.redis || {};
  const rabbitmq = configs.rabbitmq || {};

  const rabbitmq_host = `amqp://${rabbitmq.user}:${rabbitmq.pass}@${
    rabbitmq.server_address ||
    db_server_address ||
    (isSwarm ? "erxes-dbs_rabbitmq" : "rabbitmq")
  }:${db_server_address ? RABBITMQ_PORT : 5672}/${rabbitmq.vhost}`;

  return {
    ...be_env,
    ELASTIC_APM_HOST_NAME: configs.elastic_apm_host_name,
    DEBUG: configs.debug_level || "*error*",
    NODE_ENV: "production",
    DOMAIN: configs.domain,
    WIDGETS_DOMAIN: widgets.domain || `${configs.domain}/widgets`,
    REDIS_HOST: db_server_address || (isSwarm ? "erxes-dbs_redis" : "redis"),
    REDIS_PORT: db_server_address ? REDIS_PORT : 6379,
    REDIS_PASSWORD: redis.password || "",
    RABBITMQ_HOST: rabbitmq_host,
    ELASTICSEARCH_URL: `http://${
      db_server_address ||
      (isSwarm ? "erxes-dbs_elasticsearch" : "elasticsearch")
    }:9200`,
    ENABLED_SERVICES_JSON: enabledServicesJson,
    RELEASE: configs.image_tag || "",
    VERSION: configs.version || "os",
    MESSAGE_BROKER_PREFIX: rabbitmq.prefix || ""
  };
};

const cleaning = async () => {
  await execCommand("docker rm $(docker ps -a -q -f status=exited)", true);
  await execCommand("docker rmi $(docker images -f dangling=true -q)", true);
  await execCommand(
    "docker volume rm $(docker volume ls -q -f dangling=true)",
    true
  );
};

const mongoEnv = (configs, plugin) => {
  const mongo = configs.mongo || {};
  const db_server_address = configs.db_server_address;

  let db_name = mongo.db_name || "erxes";

  if (plugin && plugin.db_name) {
    db_name = plugin.db_name;
  }

  const mongo_url = `mongodb://${mongo.username}:${mongo.password}@${
    db_server_address || (isSwarm ? "erxes-dbs_mongo" : "mongo")
  }:${
    db_server_address ? MONGO_PORT : 27017
  }/${db_name}?authSource=admin&replicaSet=rs0`;

  return mongo_url;
};

const healthcheck = {
  test: [
    "CMD",
    "curl",
    "-i",
    `http://localhost:${SERVICE_INTERNAL_PORT}/health`
  ],
  interval: "30s",
  start_period: "30s"
};

const generateLBaddress = address =>
  `${address}${
    SERVICE_INTERNAL_PORT !== 80 ? `:${SERVICE_INTERNAL_PORT}` : ""
  }`;

const generatePluginBlock = (configs, plugin) => {
  const api_mongo_url = mongoEnv(configs, {});
  const mongo_url = plugin.mongo_url || mongoEnv(configs, plugin);
  const image_tag = plugin.image_tag || configs.image_tag || "federation";
  const registry = plugin.registry ? `${plugin.registry}/` : "";

  const extra_hosts = [];

  if (plugin.db_server_address || configs.db_server_address) {
    extra_hosts.push(
      `mongo:${
        plugin.db_server_address || configs.db_server_address || "127.0.0.1"
      }`
    );
  }

  if (configs.secondary_db_server_address) {
    extra_hosts.push(`mongo-secondary:${configs.secondary_db_server_address}`);
  }

  const conf = {
    image: `${registry}erxes/plugin-${plugin.name}-api:${image_tag}`,
    environment: {
      OTEL_SERVICE_NAME: plugin.name,
      SERVICE_NAME: plugin.name,
      PORT: plugin.port || SERVICE_INTERNAL_PORT || 80,
      API_MONGO_URL: api_mongo_url,
      MONGO_URL: mongo_url,
      NODE_INSPECTOR: configs.nodeInspector ? "enabled" : undefined,
      LOAD_BALANCER_ADDRESS: generateLBaddress(
        `http://plugin-${plugin.name}-api`
      ),
      ...commonEnvs(configs),
      ...(plugin.extra_env || {})
    },
    networks: ["erxes"],
    extra_hosts
  };

  if (isSwarm && plugin.replicas) {
    conf.deploy = {
      replicas: plugin.replicas
    };
  }

  return conf;
};

const syncUI = async ({ name, image_tag, ui_location }) => {
  const configs = await fse.readJSON(filePath("configs.json"));
  const tag = image_tag || configs.image_tag;

  const plName = `plugin-${name}-ui`;

  if (!(await fse.exists(filePath(`plugin-uis/${plName}`)))) {
    await execCommand(`mkdir plugin-uis/${plName}`);
  }

  if (ui_location) {
    log(`Downloading ${name} ui build.tar from ${ui_location}`);

    await execCurl(ui_location, `plugin-uis/${plName}/build.tar`);
  } else {
    log(`Downloading ${name} ui build.tar from s3`);

    let s3_location = "";

    if (!tag) {
      s3_location = `https://erxes-plugins.s3.us-west-2.amazonaws.com/uis/${plName}`;
    } else {
      if (buildPlugins.includes(tag)) {
        s3_location = `https://erxes-${tag}-plugins.s3.us-west-2.amazonaws.com/uis/${plName}`;
      } else {
        s3_location = `https://erxes-release-plugins.s3.us-west-2.amazonaws.com/uis/${plName}/${tag}`;
      }
    }

    await execCurl(
      `${s3_location}/build.tar`,
      `plugin-uis/${plName}/build.tar`
    );
  }

  log(`Extracting build ......`);
  await execCommand(
    `tar -xf plugin-uis/${plName}/build.tar --directory=plugin-uis/${plName}`
  );

  log(`Removing build.tar ......`);
  await execCommand(`rm plugin-uis/${plName}/build.tar`);
};

const updateLocales = async () => {
  const configs = await fse.readJSON(filePath("configs.json"));
  const tag = configs.image_tag || "dev";

  let s3_location = "";

  if (tag === "dev") {
    s3_location = `https://erxes-dev-plugins.s3.us-west-2.amazonaws.com`;
  } else {
    s3_location = `https://erxes-release-plugins.s3.us-west-2.amazonaws.com/${tag}`;
  }

  log(`Downloading locales from ${s3_location}`);

  await execCurl(`${s3_location}/locales.tar`, `locales.tar`);

  log(`Extracting build ......`);

  if (!(await fse.exists(filePath("locales")))) {
    await execCommand("mkdir locales");
  }

  await execCommand(`tar -xf locales.tar --directory=locales`);

  log(`Removing locales.tar ......`);
  await execCommand(`rm locales.tar`);

  const plugins = configs.plugins || [];

  for (const plugin of plugins) {
    const localesPath = `plugin-uis/plugin-${plugin.name}-ui/locales`;

    if (!(await fse.exists(filePath(localesPath)))) {
      continue;
    }

    const files = await fse.readdir(localesPath);

    for (const file of files) {
      if (!(await fse.exists(filePath(`locales/${file}`)))) {
        continue;
      }

      const globalFile = await fse.readJSON(filePath(`locales/${file}`));
      const localFile = await fse.readJSON(filePath(`${localesPath}/${file}`));

      const combined = { ...globalFile, ...localFile };

      await fse.writeJSON(filePath(filePath(`locales/${file}`)), combined);
    }
  }
};

const generateNetworks = configs => {
  if (configs.db_server_address) {
    return {
      driver: "overlay"
    };
  }

  if (!isSwarm) {
    return {
      driver: "bridge"
    };
  }

  return {
    external: true
  };
};

// const deployDbs = async () => {
//   const ora = (await import("ora")).default;
//   const spinner = ora();

//   spinner.start("Cleaning up...");
//   await cleaning();
//   spinner.succeed("Cleanup complete.");

//   spinner.start("Checking Docker swarm status...");
//   const { stdout: dockerInfo } = await execCommand("docker info", true);
//   if (!dockerInfo.includes("Swarm: active")) {
//     spinner.start("Initializing Docker swarm...");
//     await execCommand("docker swarm init", true);
//     spinner.succeed("Docker swarm initialized.");
//   } else {
//     spinner.succeed("Docker swarm is already active.");
//   }

//   spinner.start("Creating Docker network...");
//   await execCommand("docker network create --driver overlay erxes", true);
//   spinner.succeed("Docker network created.");

//   spinner.start("Reading configurations...");
//   const configs = await fse.readJSON(filePath("configs.json"));
//   spinner.succeed("Configurations read.");

//   const dockerComposeConfig = {
//     version: "3.3",
//     networks: {
//       erxes: generateNetworks(configs)
//     },
//     services: {}
//   };

//   if (configs.kibana) {
//     spinner.start("Setting up Kibana service...");
//     dockerComposeConfig.services.kibana = {
//       image: "docker.elastic.co/kibana/kibana:7.6.0",
//       ports: ["5601:5601"],
//       networks: ["erxes"]
//     };
//     spinner.succeed("Kibana service configured.");
//   }

//   if (configs.mongo) {
//     spinner.start("Setting up MongoDB service...");
//     if (!(await fse.exists(filePath("mongodata")))) {
//       await execCommand("mkdir mongodata");
//     }

//     dockerComposeConfig.services.mongo = {
//       hostname: "mongo",
//       image: "mongo:4.4.25",
//       ports: [`0.0.0.0:${MONGO_PORT}:27017`],
//       environment: {
//         MONGO_INITDB_ROOT_USERNAME: configs.mongo.username,
//         MONGO_INITDB_ROOT_PASSWORD: configs.mongo.password
//       },
//       networks: ["erxes"],
//       volumes: ["./mongodata:/data/db"],
//       extra_hosts: ["mongo:127.0.0.1"]
//     };
//     spinner.succeed("MongoDB service configured.");
//   }

//   spinner.start("Generating docker-compose-dbs.yml...");
//   const yamlString = yaml.stringify(dockerComposeConfig);
//   fs.writeFileSync(filePath("docker-compose-dbs.yml"), yamlString);
//   spinner.succeed("docker-compose-dbs.yml generated.");

//   spinner.start("Deploying databases...");

//   await execCommand(
//     "docker stack deploy --compose-file docker-compose-dbs.yml erxes-dbs --with-registry-auth --resolve-image changed"
//   );

//   spinner.succeed("Databases deployed.");
// };

const deployDbs = async () => {
  const ora = (await import("ora")).default;

  const spinner = ora();

  spinner.start("Cleaning up...");

  await cleaning();

  spinner.succeed("Cleanup complete.");

  const configs = await fse.readJSON(filePath("configs.json"));

  const dockerComposeConfig = {
    version: "3.3",
    networks: {
      erxes: generateNetworks(configs)
    },
    services: {}
  };

  if (configs.kibana) {
    dockerComposeConfig.services.kibana = {
      image: "docker.elastic.co/kibana/kibana:7.6.0",
      ports: ["5601:5601"],
      networks: ["erxes"]
    };
  }

  if (configs.mongo) {
    if (!(await fse.exists(filePath("mongodata")))) {
      await execCommand("mkdir mongodata");
    }

    dockerComposeConfig.services.mongo = {
      hostname: "mongo",
      image: "mongo:4.4.25",
      ports: [`0.0.0.0:${MONGO_PORT}:27017`],
      environment: {
        MONGO_INITDB_ROOT_USERNAME: configs.mongo.username,
        MONGO_INITDB_ROOT_PASSWORD: configs.mongo.password
      },
      networks: ["erxes"],
      volumes: ["./mongodata:/data/db"],
      // command: ["--replSet", "rs0", "--bind_ip_all"],
      extra_hosts: ["mongo:127.0.0.1"]
    };
  }

  if (configs.mongo.replication) {
    // if (!(await fse.exists(filePath(`mongo-key`)))) {
    //   log("mongo-key file not found ....", "red");
    //   return log(
    //     `Create this file using
    //       openssl rand -base64 756 > <path-to-keyfile>
    //       chmod 400 <path-to-keyfile>
    //       chmod 999:999 <path-to-keyfile>
    //   `,
    //     "red"
    //   );
    // }
    // dockerComposeConfig.services.mongo.volumes.push(
    //   "./mongo-key:/etc/mongodb/keys/mongo-key"
    // );
    // dockerComposeConfig.services.mongo.command.push("--keyFile");
    // dockerComposeConfig.services.mongo.command.push(
    //   "/etc/mongodb/keys/mongo-key"
    // );
    // dockerComposeConfig.services.mongo.extra_hosts = [
    //   `mongo:${configs.db_server_address}`,
    //   `mongo-secondary:${configs.secondary_server_address}`
    // ];
  }

  if (configs.elasticsearch) {
    if (!(await fse.exists(filePath("elasticsearchData")))) {
      await execCommand("mkdir elasticsearchData");
    }

    dockerComposeConfig.services.elasticsearch = {
      image: "docker.elastic.co/elasticsearch/elasticsearch:7.8.0",
      environment: {
        "discovery.type": "single-node"
      },
      ports: ["9200:9200"],
      networks: ["erxes"],
      volumes: ["./elasticsearchData:/usr/share/elasticsearch/data"],
      ulimits: {
        memlock: {
          soft: -1,
          hard: -1
        }
      }
    };
  }

  if (configs.redis) {
    if (!(await fse.exists(filePath("redisdata")))) {
      await execCommand("mkdir redisdata");
    }

    dockerComposeConfig.services.redis = {
      image: "redis:7.2.1",
      command: `redis-server --appendonly yes --requirepass ${configs.redis.password}`,
      ports: [`${REDIS_PORT}:6379`],
      networks: ["erxes"],
      volumes: ["./redisdata:/data"]
    };
  }

  if (configs.rabbitmq) {
    if (!(await fse.exists(filePath("rabbitmq-data")))) {
      await execCommand("mkdir rabbitmq-data");
    }

    dockerComposeConfig.services.rabbitmq = {
      image: "rabbitmq:3.7.17-management",
      hostname: "rabbitmq",
      environment: {
        RABBITMQ_VM_MEMORY_HIGH_WATERMARK: "2048MiB",
        RABBITMQ_ERLANG_COOKIE: configs.rabbitmq.cookie,
        RABBITMQ_DEFAULT_USER: configs.rabbitmq.user,
        RABBITMQ_DEFAULT_PASS: configs.rabbitmq.pass,
        RABBITMQ_DEFAULT_VHOST: configs.rabbitmq.vhost
      },
      ports: [`${RABBITMQ_PORT}:5672`, "15672:15672"],
      networks: ["erxes"],
      volumes: ["./rabbitmq-data:/var/lib/rabbitmq"]
    };
  }

  const yamlString = yaml.stringify(dockerComposeConfig);

  log("Generating docker-compose-dbs.yml ....");

  fs.writeFileSync(filePath("docker-compose-dbs.yml"), yamlString);

  spinner.start("Deploying databases...");

  // if (isSwarm) {
  await execCommand(
    "docker stack deploy --compose-file docker-compose-dbs.yml erxes-dbs --with-registry-auth --resolve-image changed"
  );
  // }

  spinner.succeed("Databases deployed.");

  return;

  // return execCommand("docker-compose -f docker-compose-dbs.yml up -d");
};

module.exports.installerUpdateConfigs = async () => {
  const type = process.argv[3];
  const name = process.argv[4];

  const configs = await fse.readJSON(filePath("configs.json"));

  if (type === "install") {
    const prevEntry = configs.plugins.find(p => p.name === name);

    if (!prevEntry) {
      configs.plugins.push({ name: name });
    }
  }

  if (type === "uninstall") {
    configs.plugins = configs.plugins.filter(p => p.name !== name);
  }

  log("Updating configs.json ....");

  await fse.writeJSON(filePath("configs.json"), configs);
};

module.exports.removeService = async () => {
  const name = process.argv[3];

  log(`Removing ${name} service ....`);

  await execCommand(`docker service rm ${name}`, true);
};

module.exports.up = program => {
  return up({
    uis: program.uis,
    fromInstaller: program.fromInstaller,
    downloadLocales: program.locales
  });
};

const dumpDb = async program => {
  if (process.argv.length < 4) {
    return console.log("Pass db name !!!");
  }

  const dbName = process.argv[3];

  const configs = await fse.readJSON(filePath("configs.json"));

  await execCommand(
    `docker ps --format "{{.Names}}" | grep mongo > docker-mongo-name.txt`
  );
  const dockerMongoName = fs
    .readFileSync("docker-mongo-name.txt")
    .toString()
    .replace("\n", "");

  log("Running mongodump ....");
  await execCommand(
    `docker exec ${dockerMongoName} mongodump -u ${configs.mongo.username} -p ${configs.mongo.password} --authenticationDatabase admin --db ${dbName}`
  );

  if (program.copydump) {
    log("Copying dump ....");
    await execCommand(`docker cp ${dockerMongoName}:/dump .`);

    log("Compressing dump ....");
    await execCommand(`tar -cf dump.tar dump`);

    log("Removing dump from container ....");
    await execCommand(`docker exec ${dockerMongoName} rm -rf dump`);

    log("Removing uncompressed dump folder ....");
    await execCommand(`rm -rf dump`);
  }
};

module.exports.deployDbs = deployDbs;
module.exports.dumpDb = dumpDb;

module.exports.update = program => {
  if (process.argv.length < 4) {
    return console.log("Pass service names !!!");
  }

  const serviceNames = process.argv[3];

  return update({ serviceNames, noimage: program.noimage, uis: program.uis });
};

module.exports.restart = () => {
  const name = process.argv[3];
  return restart(name);
};

module.exports.syncui = () => {
  const name = process.argv[3];
  const ui_location = process.argv[4];

  return syncUI({ name, ui_location });
};
