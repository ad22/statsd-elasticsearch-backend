/*
 * Flush stats to ElasticSearch (http://www.elasticsearch.org/)
 *
 * To enable this backend, include 'elastic' in the backends
 * configuration array:
 *
 *   backends: ['./backends/elastic']
 *  (if the config file is in the statsd folder)
 *
 * A sample configuration can be found in exampleElasticConfig.js
 *
 * This backend supports the following config options:
 *
 *   host:            hostname or IP of ElasticSearch server
 *   port:            port of Elastic Search Server
 *   path:            http path of Elastic Search Server (default: '/')
 *   indexPrefix:     Prefix of the dynamic index to be created (default: 'statsd')
 *   indexType:       Removed support since elasticsearch 6.x does not support multiple type fields.
 *                    _type is hardcoded to "statsd" and a new "type" field is added to the payload
 *                    which is set to one of [counters, timers, timer_data, gauges]
 *   indexTimeStamp:  Removed support and use the alias + rollover API on elasticsearch
 */

var net = require('net'),
   util = require('util'),
   http = require('http'),
   https = require('https'),
   fs = require('fs'),
   path = require('path');

// this will be instantiated to the logger
var lg;
var debug;
var flushInterval;
var elasticHost;
var elasticPort;
var elasticPath;
var elasticIndex;
var elasticUsername;
var elasticPassword;
var elasticHttps;
var elasticCertCa;

var elasticStats = {};

function transform(stats, index) {
  const payload = [];

  for (let i = 0; i < stats.length; i++) {
    payload.push(JSON.stringify({
      index: {
        "_index": index,
        "_type": "statsd"
      }
    }));
    payload.push(JSON.stringify(stats[i]));
  }

  return payload;
}

function insert(listCounters, listTimers, listTimerData, listGaugeData) {
  let payload = transform(listCounters, elasticIndex);
  payload = payload.concat(transform(listTimers, elasticIndex));
  payload = payload.concat(transform(listTimerData, elasticIndex));
  payload = payload.concat(transform(listGaugeData, elasticIndex));

  if (payload.length === 0) {
    // No work to do
    return;
  }

  payload.push('\n')
  payload = payload.join("\n");

  const optionsPost = {
    host: elasticHost,
    port: elasticPort,
    path: `${elasticPath}${elasticIndex}/_bulk`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': payload.length
    }
  };

  if (elasticUsername && elasticPassword) {
    optionsPost.auth = elasticUsername + ':' + elasticPassword;
  }

  let httpClient = http;
  if (elasticHttps) {
    httpClient = https;

    if (elasticCertCa) {
      var ca = fs.readFileSync(elasticCertCa);
      optionsPost.ca = ca;
      optionsPost.agent = new https.Agent(optionsPost);
    }
  }

  const req = httpClient.request(optionsPost, function(res) {
    res.on('data', (d) => {
      lg.log(`ES responded with ${res.statusCode}`);
      if (res.statusCode >= 400) {
        var errdata = "HTTP " + res.statusCode + ": " + d;
        lg.log('error', errdata);
      }
    });
  }).on('error', function(err) {
    lg.log('error', 'Error with HTTP request, no stats flushed.');
    console.log(err);
  });

  if (debug) {
    lg.log('ES payload:');
    lg.log(payload);
  }

  req.write(payload);
  req.end();
}

var flush_stats = function elastic_flush(ts, metrics) {
  var statString = '';
  var numStats = 0;
  var key;
  var array_counts     = new Array();
  var array_timers     = new Array();
  var array_timer_data = new Array();
  var array_gauges     = new Array();

  ts = ts * 1000;
/*
  var gauges = metrics.gauges;
  var pctThreshold = metrics.pctThreshold;
*/

  for (key in metrics.counters) {
    numStats += fm.counters(key, metrics.counters[key], ts, array_counts);
  }

  for (key in metrics.timers) {
    numStats += fm.timers(key, metrics.timers[key], ts, array_timers);
  }

  if (array_timers.length > 0) {
    for (key in metrics.timer_data) {
      fm.timer_data(key, metrics.timer_data[key], ts, array_timer_data);
    }
  }

  for (key in metrics.gauges) {
    numStats += fm.gauges(key, metrics.gauges[key], ts, array_gauges);
  }

  if (debug) {
    lg.log('metrics:');
    lg.log( JSON.stringify(metrics) );
  }

  insert(array_counts, array_timers, array_timer_data, array_gauges);

  if (debug) {
    lg.log("debug", "flushed " + numStats + " stats to ES");
  }
};

var elastic_backend_status = function (writeCb) {
  for (stat in elasticStats) {
    writeCb(null, 'elastic', stat, elasticStats[stat]);
  }
};

exports.init = function(startup_time, config, events, logger) {

  debug = config.debug;
  lg = logger;

  var configEs = config.elasticsearch || { };

  elasticHost           = configEs.host           || 'localhost';
  elasticPort           = configEs.port           || 9200;
  elasticPath           = configEs.path           || '/';
  elasticIndex          = configEs.indexPrefix    || 'statsd';
  elasticFormatter      = configEs.formatter      || 'default_format';
  elasticUsername       = configEs.username       || undefined;
  elasticPassword       = configEs.password       || undefined;
  elasticHttps          = configEs.secure         || false;
  elasticCertCa         = configEs.ca           || undefined;

  fm   = require('./' + elasticFormatter + '.js')
  if (debug) {
    lg.log("debug", "loaded formatter " + elasticFormatter);
  }

  if (fm.init) {
    fm.init(configEs);
  }
  flushInterval         = config.flushInterval;

  elasticStats.last_flush = startup_time;
  elasticStats.last_exception = startup_time;


  events.on('flush', flush_stats);
  events.on('status', elastic_backend_status);

  return true;
};
