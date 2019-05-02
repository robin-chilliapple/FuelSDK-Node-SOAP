/*
 * Copyright (c) 2016, Salesforce.com, Inc.
 * All rights reserved.
 *
 * Legal Text is available at https://github.com/forcedotcom/Legal/blob/master/License.txt
 */

'use strict';

var version     = require('../package.json').version;
var helpers     = require('./helpers');
var request     = require('request');
var xml2js      = require('xml2js');
var FuelAuth    = require('fuel-auth');

var clone         = require('lodash.clone');
var isEmpty       = require('lodash.isempty');
var isPlainObject = require('lodash.isplainobject');
var merge         = require('lodash.merge');

var parseString   = xml2js.parseString;

var FuelSoap = function(options) {
	var authOptions = options && options.auth || {};

	// use fuel auth instance if applicable
	if(authOptions instanceof  FuelAuth) {
		this.AuthClient = authOptions;
	} else {
		try {
			this.AuthClient = new FuelAuth(authOptions);
		} catch (err) {
			throw err;
		}
	}

	this.version               = version;
	this.requestOptions        = {};
	this.requestOptions.uri    = options.soapEndpoint || 'https://webservice.exacttarget.com/Service.asmx';
	this.requestOptions.method = 'POST';

	this.defaultHeaders = {
		'User-Agent': 'node-fuel/' + this.version
		, 'Content-Type': 'text/xml'
	};
};

FuelSoap.prototype.soapRequest = function(options, callback) {
	var requestOptions;

	if(typeof callback !== 'function') {
		throw new TypeError('callback argument is required');
	}

	if(!isPlainObject(options)) {
		throw new TypeError('options argument is required');
	}

	// shoudl probably replace with object.assign down the road
	requestOptions = merge(
		{}
		, this.requestOptions
		, { headers: this.defaultHeaders }
		, (options.reqOptions || {})
	);
	requestOptions.headers.SOAPAction = options.action;

	this.AuthClient.getAccessToken(clone(options.auth), function(err, body) {
		var localError, retry, authOptions;

		if(err) {
			helpers.deliverResponse('error', err, callback, 'FuelAuth');
			return;
		}

		if(!body.accessToken) {
			localError     = new Error('No access token');
			localError.res = body;
			helpers.deliverResponse('error', localError, callback, 'FuelAuth');
			return;
		}

		retry       = options.retry || false;
		authOptions = clone(options.auth);

		delete options.retry;
		delete options.auth;

		requestOptions.body = this._buildEnvelope(options.req, body.accessToken);

		request(requestOptions, function(err, res, body) {
			if(err) {
				helpers.deliverResponse('error', err, callback, 'Request Module inside soapRequest');
				return;
			}

			this._parseResponse(options.key, body, function(err, data) {
				if(err && helpers.checkExpiredToken(err) && retry) {
					options.auth = authOptions;
					this.soapRequest(options, callback);
					return;
				}

				if(err) {
					helpers.deliverResponse('error', err, callback);
				} else {
					helpers.deliverResponse('response', { body: data, res: res }, callback);
				}
			}.bind(this));
		}.bind(this));
	}.bind(this));
};

FuelSoap.prototype.create = function(type, props, options, callback, multiple) {
	
	var multiple = multiple || false;
	var body;
	var reqOptions;
	var updateQueryAllAccounts;

	if(arguments.length < 4) {
		//if options are not included
		if(Object.prototype.toString.call(arguments[2]) === "[object Function]") {
			callback = options;
			options = null;
		}
	}

	updateQueryAllAccounts = configureQueryAllAccounts(options);
	if(isEmpty(options)) {
		options = null;
	}
	
	reqOptions = helpers.parseReqOptions(options);
	
	var newObjects = props;
	
	if(multiple == true) {
		for (var i = 0; i < props.length; i++) {
			newObjects[i].$ = { 'xsi:type': type };
		}
	}
	
	body = {
		CreateRequest: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, Options: options
			, Objects: newObjects
		}
	};
	
	if(multiple == false) {
		body.CreateRequest.Objects.$ = { 'xsi:type': type };
	}

	updateQueryAllAccounts(body.CreateRequest, 'Options');
	
	this.soapRequest({
		action: 'Create'
		, req: body
		, key: 'CreateResponse'
		, retry: true
		, reqOptions: reqOptions
	}, callback);
};

FuelSoap.prototype.retrieve = function(type, props, options, callback) {
	var body;
	var clientIDs    = null;
	var defaultProps = ['Client', 'ID', 'ObjectID'];
	var filter       = null;
	var reqOptions;
	var updateQueryAllAccounts;

	if(arguments.length < 4) {
		//if props and options are not included
		if(Object.prototype.toString.call(arguments[1]) === "[object Function]") {
			callback  = props;
			clientIDs = null;
			filter    = null;
			options   = null;
			props     = defaultProps;
		}

		//if props or options is included
		if(Object.prototype.toString.call(arguments[2]) === "[object Function]") {

			callback = options;
			//check if props or filter
			if(Object.prototype.toString.call(arguments[1]) === "[object Object]") {
				clientIDs = options.clientIDs;
				filter    = options.filter;
				props     = defaultProps;
			} else {
				clientIDs = null;
				filter    = null;
				options   = null;
			}
		}
	} else {
		clientIDs = options.clientIDs;
		filter    = options.filter;
	}
	
	updateQueryAllAccounts = configureQueryAllAccounts(options);
	reqOptions = helpers.parseReqOptions(options);
	body = {
		RetrieveRequestMsg: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, RetrieveRequest: {
				ObjectType: type
				, Properties: props
			}
		}
	};

	//TO-DO How to handle casing with properties?
	if(clientIDs) {
		body.RetrieveRequestMsg.RetrieveRequest.ClientIDs = clientIDs;
	}
	
	//To add CLIENT ID to all retrieve request by Robin
	if(typeof options.Client !== "undefined") {
		body.RetrieveRequestMsg.RetrieveRequest.Client = {ID: options.Client.ID};
	}
	
	// filter can be simple or complex and has three properties leftOperand, rightOperand, and operator
	if(filter) {
		body.RetrieveRequestMsg.RetrieveRequest.Filter = this._parseFilter(filter);
	}

	updateQueryAllAccounts(body.RetrieveRequestMsg, 'RetrieveRequest');

	this.soapRequest({
		action: 'Retrieve'
		, req: body
		, key: 'RetrieveResponseMsg'
		, retry: true
		, reqOptions: reqOptions
	}, callback);
};


FuelSoap.prototype.continueretrieve = function(type, props, options, callback) {
	var body;
	var clientIDs    = null;
	var defaultProps = ['Client', 'ID', 'ObjectID'];
	var filter       = null;
	var reqOptions;
	var updateQueryAllAccounts;

	if(arguments.length < 4) {
		//if props and options are not included
		if(Object.prototype.toString.call(arguments[1]) === "[object Function]") {
			callback  = props;
			clientIDs = null;
			filter    = null;
			options   = null;
			props     = defaultProps;
		}

		//if props or options is included
		if(Object.prototype.toString.call(arguments[2]) === "[object Function]") {

			callback = options;
			//check if props or filter
			if(Object.prototype.toString.call(arguments[1]) === "[object Object]") {
				clientIDs = options.clientIDs;
				filter    = options.filter;
				props     = defaultProps;
			} else {
				clientIDs = null;
				filter    = null;
				options   = null;
			}
		}
	} else {
		clientIDs = options.clientIDs;
		filter    = options.filter;
	}

	updateQueryAllAccounts = configureQueryAllAccounts(options);
	reqOptions = helpers.parseReqOptions(options);
	body = {
		RetrieveRequestMsg: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, RetrieveRequest: {
				ContinueRequest: type
			}
		}
	};

	//TO-DO How to handle casing with properties?
	if(clientIDs) {
		body.RetrieveRequestMsg.RetrieveRequest.ClientIDs = clientIDs;
	}

	// filter can be simple or complex and has three properties leftOperand, rightOperand, and operator
	if(filter) {
		body.RetrieveRequestMsg.RetrieveRequest.Filter = this._parseFilter(filter);
	}

	updateQueryAllAccounts(body.RetrieveRequestMsg, 'RetrieveRequest');

	this.soapRequest({
		action: 'Retrieve'
		, req: body
		, key: 'RetrieveResponseMsg'
		, retry: true
		, reqOptions: reqOptions
	}, callback);
};

// TO-DO Handle other simple filter value types like DateValue
FuelSoap.prototype._parseFilter = function(filter) {
	var fType = (isObject(filter.leftOperand) && isObject(filter.rightOperand)) ? "Complex" : "Simple";
	var obj = {
		$: {
			'xsi:type': fType + "FilterPart"
		}
	};

	if(fType === "Complex") {
		obj.LeftOperand     = this._parseFilter(filter.leftOperand);
		obj.LogicalOperator = filter.operator;
		obj.RightOperand    = this._parseFilter(filter.rightOperand);
	} else {
		obj.Property       = filter.leftOperand;
		obj.SimpleOperator = filter.operator;
		obj.Value          = filter.rightOperand;
	}

	return obj;
};

FuelSoap.prototype.update = function(type, props, options, callback, multiple) {
	var multiple = multiple || false;
	var body;
	var reqOptions;
	var updateQueryAllAccounts;

	if(arguments.length < 4) {
		//if options are not included
		if(Object.prototype.toString.call(arguments[2]) === "[object Function]") {
			callback = options;
			options = null;
		}
	}

	updateQueryAllAccounts = configureQueryAllAccounts(options);
	if(isEmpty(options)) {
		options = null;
	}
	
	var newObjects = props;
	
	if(multiple == true) {
		for (var i = 0; i < props.length; i++) {
			newObjects[i].$ = { 'xsi:type': type };
		}
	}
	
	body = {
		UpdateRequest: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, Options: options
			, Objects: newObjects
		}
	};
	
	if(multiple == false) {
		body.UpdateRequest.Objects.$ = { 'xsi:type': type };
	}
	
	
	reqOptions = helpers.parseReqOptions(options);
	
	updateQueryAllAccounts(body.UpdateRequest, 'Options');

	this.soapRequest({
		action: 'Update'
		, req: body
		, key: 'UpdateResponse'
		, retry: true
		, reqOptions: reqOptions
	}, callback);
};

FuelSoap.prototype.delete = function(type, props, options, callback) {
	var body;
	var reqOptions;
	var updateQueryAllAccounts;

	if(arguments.length < 4) {
		//if options are not included
		if(Object.prototype.toString.call(arguments[2]) === "[object Function]") {
			callback = options;
			options = null;
		}
	}

	updateQueryAllAccounts = configureQueryAllAccounts(options);
	if(isEmpty(options)) {
		options = null;
	}

	reqOptions = helpers.parseReqOptions(options);
	body = {
		DeleteRequest: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, Options: options
			, Objects: props
		}
	};

	body.DeleteRequest.Objects.$ = { 'xsi:type': type };

	updateQueryAllAccounts(body.DeleteRequest, 'Options');

	this.soapRequest({
		action: 'Delete'
		, req: body
		, key: 'DeleteResponse'
		, retry: true
		, reqOptions: reqOptions
	}, callback);
};

FuelSoap.prototype.describe = function(type, callback) {
	var body = {
		DefinitionRequestMsg: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, DescribeRequests: {
				ObjectDefinitionRequest: {
					ObjectType: type
				}
			}
		}
	};

	this.soapRequest({
		action: 'Describe'
		, req: body
		, key: 'DefinitionResponseMsg'
		, retry: true
	}, callback);
};

FuelSoap.prototype.execute = function(type, props, callback) {
	var body = {
		ExecuteRequestMsg: {
			$: {
				xmlns: 'http://exacttarget.com/wsdl/partnerAPI'
			}
			, Requests: {
				Name: type
				, Parameters: props
			}
		}
	};

	this.soapRequest({
		action: 'Execute'
		, req: body
		, key: 'ExecuteResponseMsg'
		, retry: true
	}, callback);
};

FuelSoap.prototype.query = function() {};
FuelSoap.prototype.configure = function() {};
FuelSoap.prototype.extract = function() {};
FuelSoap.prototype.getSystemStatus = function() {};

FuelSoap.prototype.perform = function (type, props, options, action, callback) {

	var reqOptions = helpers.parseReqOptions(options);
	var body = {
		PerformRequestMsg: {
			'$': {
				'xmlns': 'http://exacttarget.com/wsdl/partnerAPI'
			},
			Options: options,
			Action: action,
			Definitions: {Definition:props}
		}
	};
	
	body.PerformRequestMsg.Definitions.Definition.$ = {
		'xsi:type': type
	};
	
	//updateQueryAllAccounts(body.PerformRequestMsg, 'Options');
	
	this.soapRequest({
		action: 'Perform',
		req: body,
		key: 'PerformResponseMsg',
		retry: true,
		reqOptions: reqOptions
	}, callback);
};

FuelSoap.prototype.schedule = function(type1, type2, props, callback)
{
	var body = {
		ScheduleRequestMsg: {
			'$': {
				'xmlns': 'http://exacttarget.com/wsdl/partnerAPI'
			},
			Action: 'start',
			Schedule: {Recurrence:props.recurrence, RecurrenceType:props.recurrence_type, RecurrenceRangeType:props.recurrence_range_type, StartDateTime:props.start_date_time, Occurrences:props.total_occurence},
			Interactions: {Interaction:props.interaction}
		}
	};
	
	body.ScheduleRequestMsg.Interactions.Interaction.$ = {
		'xsi:type': type1,
		'xmlns': 'http://exacttarget.com/wsdl/partnerAPI'
	};
	
	body.ScheduleRequestMsg.Schedule.Recurrence.$ = {
		'xsi:type': type2,
		'xmlns': 'http://exacttarget.com/wsdl/partnerAPI'
	};
	
	this.soapRequest({
		action: 'Schedule',
		req: body,
		key: 'ScheduleResponseMsg',
		retry: true,
		reqOptions: {}
	}, callback);
};
FuelSoap.prototype.versionInfo = function() {};

FuelSoap.prototype._buildEnvelope = function(request, token) {
	var envelope = {
		$: {
			xmlns: "http://schemas.xmlsoap.org/soap/envelope/",
			"xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"
		}
		, Header: {
			To: {
				"_": this.requestOptions.uri
			},
			fueloauth: {
				$: {
					xmlns: "http://exacttarget.com"
				}
				, "_": token
			}
		}
		, Body: request
	};

	var buildOptions = {
		rootName: "Envelope"
		, headless: true
	};

	var builder = new xml2js.Builder(buildOptions);
	
	return builder.buildObject(envelope);
};

FuelSoap.prototype._parseResponse = function(key, body, callback) {
	var parseOptions = {
		trim: true
		, normalize: true
		, explicitArray: false
		, ignoreAttrs: true
	};

	parseString(body, parseOptions, function(err, res) {
		if(err) {
			err.errorPropagatedFrom = 'xml2js.parseString';
			callback(err, null);
			return;
		}

		var soapError;
		var soapBody = res['soap:Envelope']['soap:Body'];

		// Check for SOAP Fault
		if(soapBody['soap:Fault']) {
			var fault             = soapBody['soap:Fault'];
			soapError             = new Error(fault.faultstring);
			soapError.faultstring = fault.faultstring;
			soapError.faultCode   = fault.faultcode;

			if(fault.detail) {
				soapError.detail = fault.detail;
			}

			soapError.errorPropagatedFrom = 'SOAP Fault';
			callback(soapError, null);
			return;
		}

		var parsedRes = soapBody[key];

		if(key === 'DefinitionResponseMsg') {
			// Return empty object if no ObjectDefinition is returned.
			parsedRes.ObjectDefinition = parsedRes.ObjectDefinition || {};
			callback(null, parsedRes);
			return;
		}

		// Results should always be an array
		parsedRes.Results = Array.isArray(parsedRes.Results) ? parsedRes.Results : isObject(parsedRes.Results) ? [parsedRes.Results] : [];

		if(key === 'RetrieveResponseMsg') {
			if(parsedRes.OverallStatus === 'OK' || parsedRes.OverallStatus === 'MoreDataAvailable') {
				callback(null, parsedRes);
			} else {
				// This is an error
				soapError = new Error(parsedRes.OverallStatus.split(':')[1].trim());
				soapError.requestId = parsedRes.RequestID;
				soapError.errorPropagatedFrom = 'Retrieve Response';
				callback(soapError, null);
			}
			return;
		}

		if(parsedRes.OverallStatus === 'Error' ||  parsedRes.OverallStatus === 'Has Errors') {
			soapError = new Error('Soap Error');
			soapError.requestId = parsedRes.RequestID;
			soapError.results = parsedRes.Results;
			soapError.errorPropagatedFrom = key;
			callback(soapError, null);
			return;
		}

		callback(null, parsedRes);
	}.bind(this));
};

function configureQueryAllAccounts(options) {
	var addQueryAllAccounts = false;

	if(options && options.queryAllAccounts) {
		addQueryAllAccounts = true;
		delete options.queryAllAccounts;
	}

	return function(rootElement, child) {
		if(addQueryAllAccounts) {
			rootElement[child] = rootElement[child] || {};
			rootElement[child].QueryAllAccounts = true;
		}
	};
}

function isObject(value) {
	var type = typeof value;
	return !!value && (type === 'object' || type === 'function');
}

module.exports = FuelSoap;
