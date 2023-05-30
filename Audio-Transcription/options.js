/**
 * Captures audio from the active tab in Google Chrome.
 * @returns {Promise<MediaStream>} A promise that resolves with the captured audio stream.
 */
function captureTabAudio() {
  return new Promise((resolve) => {
    chrome.tabCapture.capture(
      {
        audio: true,
        video: false,
      },
      (stream) => {
        resolve(stream);
      }
    );
  });
}


/**
 * Sends a message to a specific tab in Google Chrome.
 * @param {number} tabId - The ID of the tab to send the message to.
 * @param {any} data - The data to be sent as the message.
 * @returns {Promise<any>} A promise that resolves with the response from the tab.
 */
function sendMessageToTab(tabId, data) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, data, (response) => {
      resolve(response);
    });
  });
}


/**
 * Starts recording audio from the captured tab.
 * @param {Object} option - The options object containing the currentTabId.
 */
async function startRecord(option) {
  const stream = await captureTabAudio();
  var doVad = true;
  if (stream) {
    // call when the stream inactive
    stream.oninactive = () => {
      window.close();
    };

    // create onnx model
    // initialize onnx model
    const session = await ort.InferenceSession.create('./silero_vad.onnx');
    var h = new Array(128);
    for (let i = 0; i < h.length; i++) {
      h[i] = 0;
    }
    var c = new Array(128);
    for (let i = 0; i < h.length; i++) {
      c[i] = 0;
    }
    
    const sr = new BigInt64Array(1)
    sr[0] = BigInt(16000);
    const srate = new ort.Tensor('int64', sr, [1]);
    let speech_prob = undefined;
    const vad_infer = async (feed_dict) => {
      // feed inputs and run
      try{
        const results = await session.run(feed_dict);

        // update states
        h = results.hn.data
        c = results.cn.data
        speech_prob = results.output.data
      } catch(e) {
        console.log(e)
      }
    }

    const socket = new WebSocket("ws://localhost:9090/");
    socket.onopen = function(e) { 
      socket.send("handshake");
    };

    socket.onmessage = async (event) => {
      // console.log(event.data);
      res = await sendMessageToTab(option.currentTabId, {
        type: "transcript",
        data: event.data,
      });
    };

    const audioDataCache = [];
    const context = new AudioContext({sampleRate: 16000});
    const mediaStream = context.createMediaStreamSource(stream);
    const recorder = context.createScriptProcessor(4096, 1, 1);

    recorder.onaudioprocess = async (event) => {
      if (!context) return;

      const inputData = event.inputBuffer.getChannelData(0);

      audioDataCache.push(inputData);

      // voice activity detection inference
      const audioBuffer = new ort.Tensor('float32', inputData, [1, inputData.length]);
      const hh = new ort.Tensor('float32', h, [2, 1, 64]);
      const hc = new ort.Tensor('float32', c, [2, 1, 64]);
      const feeds = { input: audioBuffer, sr: srate, h: hh, c: hc};
      
      // feed inputs and run
      if (doVad) {
        vad_infer(feeds)
        if (speech_prob > 0.4) {
          socket.send(inputData);
        }
        else
          console.log("no speech found: " + speech_prob)
      }
    };

    // Prevent page mute
    mediaStream.connect(recorder);
    recorder.connect(context.destination);
    mediaStream.connect(context.destination);
  } else {
    window.close();
  }
}

/**
 * Listener for incoming messages from the extension's background script.
 * @param {Object} request - The message request object.
 * @param {Object} sender - The sender object containing information about the message sender.
 * @param {Function} sendResponse - The function to send a response back to the message sender.
 */
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  const { type, data } = request;

  switch (type) {
    case "start_capture":
      await startRecord(data);
      break;
    default:
      break;
  }

  sendResponse({});
});
