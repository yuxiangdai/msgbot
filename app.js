

/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request'),
  Shopify = require('shopify-api-node'),
  fs = require('fs')

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

var nlp_helper = require('./nlp_helper');

var shopping_cart = [];

//{id: recipient, product [{},{}] }

/*
 * Open config/default.json and set your config values before running this code.
 * You can also set them using environment variables.
 *
 */

// App Secret can be retrieved from the App Dashboard
const FB_APP_SECRET = (process.env.FB_APP_SECRET) ?
  process.env.FB_APP_SECRET :
  config.get('fb_appSecret');

// Arbitrary value used to validate a webhook
const FB_VALIDATION_TOKEN = (process.env.FB_VALIDATION_TOKEN) ?
  (process.env.FB_VALIDATION_TOKEN) :
  config.get('fb_validationToken');

// Generate a page access token for your page from the App Dashboard
const FB_PAGE_ACCESS_TOKEN = (process.env.FB_PAGE_ACCESS_TOKEN) ?
  (process.env.FB_PAGE_ACCESS_TOKEN) :
  config.get('fb_pageAccessToken');

const SHOPIFY_SHOP_NAME = (process.env.SHOP_NAME) ?
  process.env.SHOP_NAME :
  config.get('sh_shopName');

const SHOPIFY_API_KEY = (process.env.SHOP_API_KEY) ?
  process.env.SHOP_API_KEY :
  config.get('sh_apiKey');

const SHOPIFY_API_PASSWORD = (process.env.SHOP_API_PASSWORD) ?
  process.env.SHOP_API_PASSWORD :
  config.get('sh_apiPassword');

const HOST_URL = (process.env.HOST_URL) ?
  process.env.HOST_URL :
  config.get('host_url');

// make sure that everything has been properly configured
if (!(FB_APP_SECRET && FB_VALIDATION_TOKEN && FB_PAGE_ACCESS_TOKEN && SHOPIFY_SHOP_NAME && SHOPIFY_API_KEY && SHOPIFY_API_PASSWORD && HOST_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

const shopify = new Shopify({
  shopName: SHOPIFY_SHOP_NAME,
  apiKey: SHOPIFY_API_KEY,
  password: SHOPIFY_API_PASSWORD
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * your App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // In DEV, log an error. In PROD, throw an error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', FB_APP_SECRET)
                        .update(buf)
                        .digest('hex');

    //console.log("signatureHash: " + signatureHash);
    //console.log("expectedHash: " + expectedHash);

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Use your own validation token. Check that the token used in the Webhook
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === FB_VALIDATION_TOKEN) {
    console.log("[app.get] Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/**
 * serves a static page for the webview
 */
app.get('/product_description', function(req, res) {
  var product_id = req.query['id'];
  if (product_id !== 'null') {
    console.log("[app.get] product id:" + product_id);
    var sh_product = shopify.product.get(product_id);
    sh_product.then(function(product) {
      console.log(product.options[0].values);
      res.status(200).send(product.body_html);
    }, function(error) {
      console.error("Error retrieving product");
      res.sendStatus(400).send("Error retrieving product");
    });

  } else {
    console.error("Product id is required");
    res.sendStatus(400).send("Product id is required");
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  // You must send back a status 200 to let the Messenger Platform know that you've
  // received the callback. Do that right away because the countdown doesn't stop when
  // you're paused on a breakpoint! Otherwise, the request might time out.
  res.sendStatus(200);

  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // entries may be batched so iterate over each one
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {

        let propertyNames = [];
        for (var prop in messagingEvent) { propertyNames.push(prop)}
        console.log("[app.post] Webhook received a messagingEvent with properties: ", propertyNames.join());

        if (messagingEvent.message) {
          // someone sent a message
          receivedMessage(messagingEvent);

        } else if (messagingEvent.delivery) {
          // messenger platform sent a delivery confirmation
          receivedDeliveryConfirmation(messagingEvent);

        } else if (messagingEvent.postback) {
          // user replied by tapping one of our postback buttons
          receivedPostback(messagingEvent);

        } else {
          console.log("[app.post] Webhook is not prepared to handle this message.");

        }
      });
    });
  }
});

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 */
var download = function(uri, filename, callback){
  request.head(uri, function(err, res, body){
    console.log('content-type:', res.headers['content-type']);
    console.log('content-length:', res.headers['content-length']);

    request(uri).pipe(fs.createWriteStream(filename)).on('close', callback);
  });
};

function receivedMessage(event) {
  var senderID = event.sender.id;
  var pageID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  var msgAttach = message.attachments;
 
  if (msgAttach){
    var url = msgAttach[0].payload.url;
    console.log("image url:", url);
    download(url, timeOfMessage.toString(), function(){
      console.log('downloaded to root directory');
    });
  }

  if (message['nlp']) {
      var parsed = message['nlp']['entities'];

    console.log("[receivedMessage] user (%d) page (%d) timestamp (%d) and message (%s)",
      // senderID, pageID, timeOfMessage, JSON.stringify(message));
      senderID, pageID, timeOfMessage, JSON.stringify(event.message));


    if (message.quick_reply) {
      console.log("[receivedMessage] quick_reply.payload (%s)",
        message.quick_reply.payload);
      handleQuickReplyResponse(event);
      return;
    }

    var messageText = message.text;
    if (messageText) {

      var lcm = messageText.toLowerCase();
      switch (lcm) {
        // if the text matches any special keywords, handle them accordingly
        case 'help':
          sendHelpOptionsAsButtonTemplates(senderID);
          break;
        case 'reset':
          reset(senderID);
          break;
        case 'hello':
          hello(senderID);
        case 'thanks':
          thanks(senderID);
        // sends info about a specific
        // case 'info':
        default:
          // otherwise, just echo it back to the sender
          var thresConf = 0.8; //threshhold_confidence
          //code for general check for what is proposed
          // if (parsed['____'] != null){
          //   _____ = parsed['___'][0]['confidence'] > thresConf;
          // }
          //find out if greeting was proposed
          var greet = 0;

          if (parsed['greeting'] != null){
            greet = parsed['greeting'][0]['confidence'] > thresConf;
          }
          //find out if bye was proposed
          var bye = 0;
          if (parsed['bye'] != null){
            bye = parsed['bye'][0]['confidence'] > thresConf;
          }
          //find out if thanks was proposed
          var thanks = 0;
          if (parsed['thanks'] != null){
            thanks = parsed['thanks'][0]['confidence'] > thresConf;
          }
          //find if instruction or question proposed
          var instr = 0;
          var quest = 0;
          if (parsed['instruction'] != null){
            instr = parsed['instruction'][0]['confidence'] > thresConf;
          }
          if (parsed['question'] !=null) {
            quest = parsed['question'][0]['confidence'] > thresConf;
          }

          //console.log(parsed['instruction'][0]['confidence'])
          var inquiry = instr || quest;
          var productArr = [];
          var proposal = 'initial';
          if (greet) {
            proposal = 'greet';
          } else if (bye){
            proposal = 'bye';
          } else if (thanks){
            proposal = 'thanks';
          } else if (inquiry){
            proposal = 'inquiry';
          } else {
            proposal = 'undefined';
          }
          switch (proposal){
            case 'greet':
              var arrofGreetings = ['Hi!','Hello!','Hey!'];
              var greettosend = arrofGreetings[Math.floor(Math.random()*items.length)];
              sendTextMessage(senderID, greettosend);
            break;
            case 'bye':
              var arrofByes = ['See you later!','Goodbye!','Bye!'];
              var byetosend = arrofByes[Math.floor(Math.random()*arrofByes.length)];
              sendTextMessage(senderID, byetosend);
            break;
            case 'thanks':
              var arrThanks = ['Anything else I can help with? :)','Happy to help!','No problem!!'];
              var thankstosend = arrThanks[Math.floor(Math.random()*arrThanks.length)];
              sendTextMessage(senderID, thankstosend);
            break;
            case 'inquiry':
              if (parsed['descriptor'] != null){
                if (parsed['descriptor'][0]['confidence'] > thresConf) {
                  var descriptor = parsed['descriptor'][0]['value'];
                  var descripArr = descriptor.split(' ');
                  productArr = descripArr;
                }
              }
              if (parsed['product_type'] != null){
                if (parsed['product_type'][0]['confidence'] > thresConf) {
                  var prod_type = parsed['product_type'][0]['value'];
                  productArr.push(prod_type);
                }
              }
              var product = [descriptor, prod_type];
              sendProductInfo(senderID, productArr, lcm);
            break;
            default:
              //sendProductInfo(senderID, [messageText], lcm);
              sendTextMessage(senderID, messageText);
          }
          
        }
    }
  }
}


function hello(recipientId){

  var messageData = {
    recipient: {
      id: recipientId
    },
    "message":{
      "text": "hello."
    }
  };
  callSendAPI(messageData);
}


function thanks(recipientId){
  
    var messageData = {
      recipient: {
        id: recipientId
      },
      "message":{
        "text": "you're welcome."
      }
    };
    callSendAPI(messageData);
  }

function reset(recipientId){

  var textButton = function(title, action, options) {
    var payload = options | {};
    payload = Object.assign(options, {action: action});
    return {
      "content_type":"text",
      title: title,
      payload: JSON.stringify(payload)
    };
  }

  var messageData = {
    recipient: {
      id: recipientId
    },
    "message":{
      "text": "Please select one of the options below to begin.",
      "quick_replies":[
        textButton('Trending', 'QR_GET_BEST', {limit: 10}),
        textButton('Search', 'QR_SEARCH', {limit: 3}),
        textButton('Saved', 'QR_SAVED_ITEMS', {limit: 3})

      ]
    }
  };
  callSendAPI(messageData);
}

function sendProductInfo(recipientId, product_arr, lcm){
  var templateElements = [];
  var productList = [];
  var productIDList = [];
  var description = product_arr[0]
  var product_type = product_arr[product_arr.length - 1];
  console.log(product_arr)

  var sectionButton = function(title, action, options) {
    var payload = options | {};
    payload = Object.assign(options, {action: action});
    return {
      type: 'postback',
      title: title,
      payload: JSON.stringify(payload)
    };
  }

    var descriptor = product_arr[product_arr.length - 1];
    var newProductList = [];
    var newProductIDList = [];

    var products = shopify.product.list({"title": descriptor}); // title tag and description
    // var productTagSearch = shopify.product.list({"tags": descriptor});
    // var productDescSearch = shopify.product.list({"body_html": descriptor});
    products.then(function(listOfProducs) {
      listOfProducs.forEach(function(product) {

          var url = HOST_URL + "/product.html?id="+product.id;

          if(description != null){
            console.log(product.title)
            console.log(description)
            console.log(product.title.toLowerCase().includes(description))
            if(product.title.toLowerCase().includes(description)){
          templateElements.push({
            title: product.title,
            subtitle: product.tags,
            image_url: product.image.src,
            buttons:[
              {
                "type":"web_url",
                "url": url,
                "title":"Read description",
                "webview_height_ratio": "compact",
                "messenger_extensions": "true"
              },
              sectionButton('Get options', 'QR_GET_PRODUCT_OPTIONS', {id: product.id}),
              sectionButton('Save this item', 'QR_SAVE', {id: product.id})
            ]
          })
        }
      }
      });

      if(templateElements.length == 0){
        var messageData = {
          recipient: {
            id: recipientId
          },
          message: {
            text: "No items found! Try again."
          }
        };
      } else {
        var messageData = {
          recipient: {
            id: recipientId
          },
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "generic",
                elements: templateElements.slice(0, 10)
              }
            }
          }
        };
      }

      callSendAPI(messageData);

      });
}


/*
 * Send a message with buttons.
 *
 */
function sendHelpOptionsAsButtonTemplates(recipientId) {
  console.log("[sendHelpOptionsAsButtonTemplates] Sending the help options menu");
  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment:{
        type:"template",
        payload:{
          template_type:"button",
          text:"Click the button before to get a list of 3 of our products.",
          buttons:[
            {
              "type":"postback",
              "title":"Get 3 products",
              "payload":JSON.stringify({action: 'QR_GET_PRODUCT_LIST', limit: 3})
            }
            // limit of three buttons
          ]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Someone tapped one of the Quick Reply buttons so
 * respond with the appropriate content
 *
 */
function handleQuickReplyResponse(event) {
  var senderID = event.sender.id;
  var pageID = event.recipient.id;
  var message = event.message;
  var quickReplyPayload = message.quick_reply.payload;

  console.log("[handleQuickReplyResponse] Handling quick reply response (%s) from sender (%d) to page (%d) with message (%s)",
    quickReplyPayload, senderID, pageID, JSON.stringify(message));

  // use branched conversation with one interaction per feature (each of which contains a variable number of content pieces)
  respondToHelpRequestWithTemplates(senderID, quickReplyPayload);
}

/*
 * This response uses templateElements to present the user with a carousel
 * You send ALL of the content for the selected feature and they can
 * swipe from side to side to see it
 *
 */

function contains(list, recipientID){
  for(var i = 0; i < list.length; i++){
    if (list[i].id === recipientID){
      return i;
    }
  }
  return false
}

function respondToHelpRequestWithTemplates(recipientId, requestForHelpOnFeature) {
  console.log("[respondToHelpRequestWithTemplates] handling help request for %s",
    requestForHelpOnFeature);
  var templateElements = [];

  var requestPayload = JSON.parse(requestForHelpOnFeature);

  var sectionButton = function(title, action, options) {
    var payload = options | {};
    payload = Object.assign(options, {action: action});
    return {
      type: 'postback',
      title: title,
      payload: JSON.stringify(payload)
    };
  }

  var textButton = function(title, action, options) {
    var payload = options | {};
    payload = Object.assign(options, {action: action});
    return {
      "content_type":"text",
      title: title,
      payload: JSON.stringify(payload)
    };
  }

  switch (requestPayload.action) {
    case 'QR_SAVE':
        var recipientID_str = recipientId.toString();
        var sh_product = shopify.product.get(requestPayload.id);

        sh_product.then(function(product){if (contains(shopping_cart, recipientId) === false){
          shopping_cart.push({'id': recipientID_str, 'product': [product]});

        }
        else{
          var i = contains(shopping_cart, recipientId);
          shopping_cart[i]['product'].push(product);
        }

        console.log(shopping_cart[0]['product'].id)
        console.log(shopping_cart[0].product[0].id)
        console.log(shopping_cart[0]['product'].title)
        console.log(shopping_cart[0]['product'].tags)
      })
        var messageData = {
        recipient: {
          id: recipientId
        },
        "message":{
          "text": "Saved Item!"
        }
      }
      callSendAPI(messageData);
        break;

        case 'QR_DEL':
          var  i = contains(shopping_cart, recipientId);
          var index;
          for(var j; j < shopping_cart[i]['product'].length; j++){
            if (shopping_cart[i]['product'][j].id === requestPayload.id){
              index = j;
              break;
            }
          }
          shopping_cart[i]['product'].splice(index, 1)


          var messageData = {
            recipient: {
              id: recipientId
            },
            "message":{
              "text": "Deleted Item!"
            }
          }
          callSendAPI(messageData);
        break;

        case 'QR_SAVED_ITEMS':
        
          var a = contains(shopping_cart, recipientId);
          if(a === false || shopping_cart[a]['product'].length <= 0)
          {
            var message = "You have no items"
            var messageData = {
              recipient: {
                id: recipientId
              },
              "message":{
                "text": message
              }
            }
            callSendAPI(messageData);
          } else {
            var  i = contains(shopping_cart, recipientId);
            console.log(i)
            shopping_cart[i]['product'].forEach(function(product) {
                var url = HOST_URL + "/product.html?id="+product.id;


                console.log(product.id)
                console.log(product.title)
                console.log(product.tags)

                templateElements.push({
                  title: product.title,
                  subtitle: product.tags,
                  image_url: product.image.src,
                  buttons:[
                    {
                      "type":"web_url",
                      "url": url,
                      "title":"Read description",
                      "webview_height_ratio": "compact",
                      "messenger_extensions": "true"
                    },
                    sectionButton('Delete', 'QR_DEL', {id: product.id})
                  ]
                });
              });

              var messageData = {
                recipient: {
                  id: recipientId
                },
                message: {
                  attachment: {
                    type: "template",
                    payload: {
                      template_type: "generic",
                      elements: templateElements.slice(0, 10)
                    }
                  }
                }
              };
              callSendAPI(messageData);

          }

          console.log(shopping_cart)
        break;


    case 'QR_SEARCH':
      var messageData = {
        recipient: {
          id: recipientId
        },
        "message":{
          "text": "Please enter a search query"
        }
      }
      callSendAPI(messageData);
    break;

    case 'QR_GET_BEST':
    var products = shopify.product.list({ limit: requestPayload.limit});
    products.then(function(listOfProducs) {
      listOfProducs.forEach(function(product) {
        var url = HOST_URL + "/product.html?id="+product.id;
        templateElements.push({
          title: product.title,
          subtitle: product.tags,
          image_url: product.image.src,
          buttons:[
            {
              "type":"web_url",
              "url": url,
              "title":"Read description",
              "webview_height_ratio": "compact",
              "messenger_extensions": "true"
            },
            sectionButton('Get options', 'QR_GET_PRODUCT_OPTIONS', {id: product.id}),
            sectionButton('Save this item', 'QR_SAVE', {id: product.id})
          ]
        });
      });

      var messageData = {
        recipient: {
          id: recipientId
        },
        "message":{
          "text": "Showing the top ten best-sellers:"
        }
      }
      callSendAPI(messageData);

      var messageData = {
        recipient: {
          id: recipientId
        },
        message: {

          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: templateElements.slice(0, 10)
            }
          }
        }
      };
      callSendAPI(messageData);
    });
    break;

    case 'QR_GET_GREETING':
        var messageData = {
          recipient: {
            id: recipientId
          },
          "message":{
            "text": "Please select one of the options below to begin.",
            "quick_replies":[
              textButton('Trending', 'QR_GET_BEST', {limit: 3}),
              textButton('Search', 'QR_SEARCH', {limit: 3}),
              textButton('Saved', 'QR_SAVED_ITEMS', {limit: 3})

            ]
          }
        };
        callSendAPI(messageData);

      break;

    case 'QR_GET_PRODUCT_LIST':
      var products = shopify.product.list({ limit: requestPayload.limit});
      products.then(function(listOfProducs) {
        listOfProducs.forEach(function(product) {
          var url = HOST_URL + "/product.html?id="+product.id;
          templateElements.push({
            title: product.title,
            subtitle: product.tags,
            image_url: product.image.src,
            buttons:[
              {
                "type":"web_url",
                "url": url,
                "title":"Read description",
                "webview_height_ratio": "compact",
                "messenger_extensions": "true"
              },
              sectionButton('Get options', 'QR_GET_PRODUCT_OPTIONS', {id: product.id})
            ]
          });
        });

        var messageData = {
          recipient: {
            id: recipientId
          },
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "generic",
                elements: templateElements
              }
            }
          }
        };
        callSendAPI(messageData);
      });
      break;

    case 'QR_GET_PRODUCT_OPTIONS':
      var sh_product = shopify.product.get(requestPayload.id);
      sh_product.then(function(product) {
        var options = '';
        product.options.map(function(option) {
          options = options + option.name + ': ' + option.values.join(',') + "\n";
        });
        var messageData = {
          recipient: {
            id: recipientId
          },
          message: {
            text: options.substring(0, 640),
            quick_replies: [
              textButton('Get 3 products', 'QR_GET_PRODUCT_LIST', {limit: 3})
            ]
          },
        };
        callSendAPI(messageData);
      });
      break;

      case 'QR_GET_PRICE':
        var sh_product = shopify.product.get(requestPayload.id);
        sh_product.then(function(product) {
          var options = '';
          product.options.map(function(option) {
            options = options + option.name + ': ' + option.values.join(',') + "\n";
          });
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {
              text: options.substring(0, 640),
              quick_replies: [
                textButton('Get 3 products', 'QR_GET_PRODUCT_LIST', {limit: 3})
              ]
            },
          };
          callSendAPI(messageData);
        });
      break;
  }

}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id; // the user who sent the message
  var recipientID = event.recipient.id; // the page they sent it from
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("[receivedDeliveryConfirmation] Message with ID %s was delivered",
        messageID);
    });
  }

  console.log("[receivedDeliveryConfirmation] All messages before timestamp %d were delivered.", watermark);
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  console.log("[receivedPostback] from user (%d) on page (%d) with payload ('%s') " +
    "at (%d)", senderID, recipientID, payload, timeOfPostback);

  respondToHelpRequestWithTemplates(senderID, payload);
}

/*
 * Send a text message using the Send API.
 *
 */



function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Sorry, I don't understand '" + messageText + "'", // utf-8, 640-character max
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: FB_PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("[callSendAPI] Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
      console.log("[callSendAPI] Successfully called Send API for recipient %s",
        recipientId);
      }
    } else {
      console.error("[callSendAPI] Send API call failed", response.statusCode, response.statusMessage, body.error);
    }
  });
}

/*
 * Send profile info. This will setup the bot with a greeting and a Get Started button
 */
function callSendProfile() {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messenger_profile',
    qs: { access_token: FB_PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: {
      "greeting":[
          {
          "locale":"default",
          "text":`Hi there! I'm a bot here to assist you with Candyboxx's Shopify store. To get started, click the "Get Started" button or type "help".`
          }
      ] ,
      "get_started": {
        "payload": JSON.stringify({action: 'QR_GET_GREETING'})
      },
      "whitelisted_domains":[
        HOST_URL
      ]
    }

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      console.log("[callSendProfile]: ", body);
      var result = body.result;
      if (result === 'success') {
        console.log("[callSendProfile] Successfully sent profile.");
      } else {
        console.error("[callSendProfile] There was an error sending profile.");
      }
    } else {
      console.error("[callSendProfile] Send profile call failed", response.statusCode, response.statusMessage, body.error);
    }
  });
}

/*
 * Start server
 * Webhooks must be available via SSL with a certificate signed by a valid
 * certificate authority.
 */
app.listen(app.get('port'), function() {
  console.log('[app.listen] Node app is running on port', app.get('port'));
  callSendProfile();
});

module.exports = app;
