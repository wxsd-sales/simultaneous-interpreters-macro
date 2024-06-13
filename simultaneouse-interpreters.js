/********************************************************
 *
 * Macro Author:      	William Mills
 *                    	Technical Solutions Specialist
 *                    	wimills@cisco.com
 *                    	Cisco Systems
 *
 * Version: 1-0-1
 * Released: 06/13/24
 *
 * Example macro which adds devices to a Webex Meeting when
 * simultaneous interpreters are present and automatically
 * make the additional devices select specific audio channel
 * languages.
 *
 * Full Readme, source code and license details for this macro
 * are available on Github:
 * https://github.com/wxsd-sales/simultaneous-interpreters-macro
 *
 ********************************************************/

import xapi from "xapi";

/*********************************************************
 * Configure the settings below
 **********************************************************/

const config = {
  codecs: [
    {
      language: "floor", // Audio Channel which this codec will only use
      ip: "<main codes IP>",
      serial: "<main codes serial>",
      username: "<main codes local account username>",
      password: "<main codes local account password>",
    },
    {
      language: "es", // Audio Channel which this codec will only use
      ip: "<aux codes IP>",
      serial: "<main codes serial>",
      username: "<aux codes local account username>",
      password: "<aux codes local account password>",
    },
    {
      language: "fr", // Audio Channel which this codec will only use
      ip: "<aux codes IP>",
      serial: "<aux codes serial>",
      username: "<aux codes local account username>",
      password: "<aux codes local account password>",
    },
  ],
  debugging: false,
  panelId: "simacro",
};

const localization = {
  paticipantTypePrompts: {
    guestOrHost: "Are you the meeting host?",
    panelistOrAttendee: "Are your a Panelist or Attendee?",
  },
  enterPinPrompts: {
    Guest: "Enter the meeting password followed by #",
    Host: "Enter the host key or personal room PIN followed by #",
    Panelist: "Enter the webinar Panelist password followed by #",
  },
  errorWithPin: "Incorrect numberic meeting password, please try again.",
};

/*********************************************************
 * Variables
 **********************************************************/

let self;
let otherCodecs;
let call = null;
let spinnerState = 0;
let spinnerInterval;
let digits = "";

init();
async function init() {
  // Only start macro 60 seconds after boot
  const uptime = await xapi.Status.SystemUnit.Uptime.get();
  if (uptime < 60) {
    console.log(
      "Device has just booted, waiting for the 60 second mark to start macro"
    );
    setTimeout(init, 60 - uptime);
    return;
  }

  // Idenfity the Role this Device should be based off config
  self = await identifySelf(config.codecs);

  if (!self) {
    const macroName = _main_macro_name();
    console.warn(
      `No config found this device - disabling macro [${macroName}]`
    );
    return;
  }

  if (self.language == "floor") {
    otherCodecs = config.codecs.filter((codec) => codec.language != "floor");

    xapi.Status.Call["*"].on((status) => {
      if (status.hasOwnProperty("ghost")) {
        // call ended, clean up
        console.log("Call Ended - Signalling Other Codecs to disconnect");
        disconnectOtherCodecs();
        call = null;
        return;
      }

      if (call?.id == status.id) return;

      if (
        status.hasOwnProperty("Direction") &&
        status.Direction == "Outgoing"
      ) {
        // Outgoing call detected
        if (status.RemoteNumber.endsWith("webex.com")) {
          console.log("New Webex Call Detected, storing details");
          console.log(status);
          call = status;
          return;
        }
      }
      console.log(status);
    });

    return;
  }

  console.log("This device handles language:", self.language);
  const mainCodec = config.codecs.find((codec) => codec.language == "floor");
  if (!mainCodec) return;
  const mainCodecsName = await getOtherCodecDisplayName(mainCodec);
  console.log("Main Codecs Name", mainCodecsName);
}

/*********************************************************
 * Subscriptions
 **********************************************************/
xapi.Event.UserInterface.Extensions.Event.PageClosed.on(async ({ PageId }) => {
  if (PageId != config.panelId) return;
  const conference = await xapi.Status.Conference.get();
  console.log("conferenece status:", JSON.stringify(conference));
  const authRequest = conference?.Call?.[0]?.AuthenticationRequest;
  if (!authRequest) return;
  if (authRequest == "None" && digits != "") {
    const languages =
      conference?.Call?.[0]?.SimultaneousInterpretation?.Languages;
    console.log("Languages", languages);
    if (languages && languages.length > 0) {
      const call = await xapi.Status.Call.get();
      const callbackNumber = call?.[0]?.CallbackNumber;
      if (!callbackNumber) return;

      console.log(
        "Adding other codecs to call:",
        callbackNumber,
        " with pin",
        digits
      );

      requestCodecsJoinMeeting(
        normaliseRemoteURI(callbackNumber),
        "Guest",
        digits.replace("#", "")
      );
    }
    return;
  }
  if (authRequest == "None") return;
  xapi.Command.Call.Disconnect();
});

if (config.debugging) {
  xapi.Event.Conference.ParticipantList.NewList.on(async ({ CallId }) => {
    const result = await xapi.Command.Conference.ParticipantList.Search({
      CallId,
    });
    console.debug("New Plist:", JSON.stringify(result));
  });

  xapi.Event.Conference.ParticipantList.ParticipantUpdated.on((value) =>
    console.debug("Pupdated:", value)
  );

  xapi.Event.Conference.ParticipantList.on((value) =>
    console.debug("Plist Event:", value)
  );
}

xapi.Event.Conference.Call.AuthenticationResponse.on(
  ({ PinEntered, PinError }) => {
    if (PinEntered) {
      if (PinEntered.AuthenticatingPin == "False") {
        setDisplay(" • ".repeat(parseInt(PinEntered.NumDigitsEntered)));
      } else {
        startSpinner();
      }
      return;
    }

    if (PinError) {
      stopSpinner();
      digits = "";
      setDisplay(localization.errorWithPin);
    }
  }
);

function setDisplay(text) {
  const WidgetId = `${config.panelId}-display`;
  xapi.Command.UserInterface.Extensions.Widget.SetValue({
    Value: text,
    WidgetId,
  });
}

xapi.Status.Conference.Call.AuthenticationRequest.on(async (value) => {
  console.log("Auth Request Status:", value);

  // None	The device is not waiting for an authentication response (no authentication request).
  // HostPinOrGuest	Participants are asked whether they want to join as a host or guest. They must provide the corresponding host PIN, or join as a guest without PIN.
  // HostPinOrGuestPin	Participants are asked whether they want to join as a host or guest. They must provide the corresponding host PIN or guest PIN.
  // AnyHostPinOrGuestPin	Participants are not asked if they are a host or guest; the role is not required. They must provide either a host PIN or guest PIN.
  // PanelistPin	Participants must provide a panelist PIN for joining a Webex Webinar as panelist. Joining as attendee is not supported for this webinar.
  // PanelistPinOrAttendeePin	Participants are asked whether they want to join a Webex Webinar as panelist or attendee. They must provide the corresponding panelist PIN or attendee PIN.
  // PanelistPinOrAttendee	Participants are asked whether they want to join a Webex Webinar as panelist or attendee. They must provide the corresponding panelist PIN or join as attendee without PIN.
  // GuestPin	Participants must provide a guest PIN.

  switch (value) {
    case "HostPinOrGuest":
    case "HostPinOrGuestPin":
      createKeypad("guest");
      break;

    case "AnyHostPinOrGuestPin":

    case "None":
      xapi.Command.UserInterface.Extensions.Panel.Close();
  }
  if (value !== "HostPinOrGuestPin") return;
  await createHostOrGuestPrompt();
  xapi.Command.UserInterface.Extensions.Panel.Open({ PanelId: config.panelId });
});

xapi.Status.Conference.Call["*"].SimultaneousInterpretation.Languages.on(
  async (status) => {
    console.log("New SI Language Available:", status);
    const languageName = status?.LanguageName;

    if (self.language == "floor") {
      const codec = otherCodecs.find((codec) => codec.language == languageName);
      if (!codec) return;
      if (!call) return;
      const conference = await xapi.Status.Conference.get();
      const participantAdd =
        conference?.Call?.[0]?.Capabilities?.ParticipantAdd;
      if (!participantAdd) return;
      if (participantAdd == "Unavailable") {
        console.log("ParticipantAdd Unavailable - Instructing Codec to dial");
        const call = await xapi.Status.Call.get();
        const callbackNumber = call?.[0]?.CallbackNumber;
        if (!callbackNumber) return;

        console.log(
            "Adding other codecs to call:",
            callbackNumber,
            " with pin",
            digits
        );

        requestCodecsJoinMeeting(
            normaliseRemoteURI(callbackNumber),
            "Guest",
            digits.replace("#", "")
        );
      } else if (participantAdd) {
        console.log("Participiant Add Capabiliities Available");
      }
    } else if (self.language == languageName) {
      console.log(
        "Setting Conference SI Langeuge To:",
        languageName,
        " with Mixer: 100"
      );
      xapi.Command.Conference.SimultaneousInterpretation.SelectLanguage({
        LanguageCode: status.LanguageCode,
      });
      xapi.Command.Conference.SimultaneousInterpretation.SetMixer({
        Level: 100,
      });
    }
  }
);

xapi.Event.UserInterface.Extensions.Widget.Action.on(async (event) => {
  if (!event.WidgetId.startsWith(config.panelId)) return;
  if (event.Type != "clicked") return;
  console.log(event);
  const [_panelId, type, value, role] = event.WidgetId.split("-");

  switch (type) {
    case "key":
      if (value == "Back") {
        createHostOrGuestPrompt();
        break;
      } else {
        digits = value == "⌫" ? digits.slice(0, -1) : digits + value;
        xapi.Command.Conference.Call.AuthenticationResponse({
          ParticipantRole: role,
          Pin: digits,
        });
      }

      break;
    case "response":
      digits = "";
      if (value == "Yes") {
        xapi.Command.Conference.Call.AuthenticationResponse({
          ParticipantRole: "Host",
        });
        createKeypad("Host");
      } else {
        xapi.Command.Conference.Call.AuthenticationResponse({
          ParticipantRole: "Guest",
        });
        createKeypad("Guest");
      }
      break;
  }
});

/**
 * Identifies the role or the current codec
 * @param {array} codecs - Array of Codecs from config
 */
async function identifySelf(codecs) {
  const serial =
    await xapi.Status.SystemUnit.Hardware.Module.SerialNumber.get();
  return codecs.find((codec) => codec.serial == serial);
}

async function getOtherCodecDisplayName(codec) {
  const auth = btoa(`${codec.username}:${codec.password}`);
  const query = "/Status/UserInterface/ContactInfo/Name";

  const parms = {
    Timeout: 5,
    AllowInsecureHTTPS: "True",
    Header: ["Authorization: Basic " + auth, "Accept: application/json"],
    Url: `https://${codec.ip}/getxml?location=` + query,
  };

  try {
    const result = await xapi.Command.HttpClient.Get(parms);
    const body = result?.Body;
    if (!body) return;
    if (!body.includes("</Name>")) return;
    const name = body.split("<Name>")[1].split("</Name>")[0];
    return name;
  } catch (error) {
    return;
  }
}

async function disconnectOtherCodecs() {
  const command = "<Command><Call><Disconnect/></Call></Command>";
  const requests = otherCodecs.map(async (codec) =>
    sendCommand(codec, command)
  );
  return Promise.all(requests);
}

async function haveOtherCodecDial(codec) {
  const command = "<Command><Call><Disconnect/></Call></Command>";
  const requests = otherCodecs.map(async (codec) =>
    sendCommand(codec, command)
  );
  return Promise.all(requests);
}

function sendCommand(codec, payload) {
  const auth = btoa(`${codec.username}:${codec.password}`);
  const parms = {
    Timeout: 5,
    AllowInsecureHTTPS: "True",
    Header: ["Authorization: Basic " + auth, "Content-Type: text/xml"],
    Url: `https://${codec.ip}/putxml`,
  };
  return xapi.Command.HttpClient.Post(parms, payload);
}


function requestCodecsJoinMeeting(number, role, pin) {
  number = number ? `<Number>${number}</Number>` : "";
  role = role ? `<ParticipantRole>${role}</ParticipantRole>` : "";
  pin = pin ? `<Pin>${pin}</Pin>` : "";
  const command = `<Command><Webex><Join>${number}${role}${pin}</Join></Webex></Command>`;
  const requests = otherCodecs.map(async (codec) =>
    sendCommand(codec, command)
  );
  return Promise.all(requests);
}

function normaliseRemoteURI(number) {
  const re = new RegExp("^(sip:|h323:|spark:|h320:|webex:|locus:)");
  return number.replace(re, "");
}

function startSpinner() {
  spinnerInterval = setInterval(updateSpinner, 300);
}

function stopSpinner() {
  if (!spinnerInterval) return;
  clearInterval(spinnerInterval);
  spinnerInterval = null;
}

function updateSpinner() {
  const spinner = ["◜", "◝", "◞", "◟"];
  const WidgetId = `${config.panelId}-display`;
  if (spinnerState == spinner.length - 1) {
    spinnerState = 0;
  } else {
    spinnerState = spinnerState + 1;
  }
  const Value = spinner[spinnerState];
  xapi.Command.UserInterface.Extensions.Widget.SetValue({ Value, WidgetId });
}

function createHostOrGuestPrompt() {
  const panelId = config.panelId;
  const responses = ["Yes", "No"]
    .map(
      (response) =>
        `<Widget>
      <WidgetId>${panelId}-response-${response}</WidgetId>
      <Name>${response}</Name>
      <Type>Button</Type>
      <Options>size=2</Options>
    </Widget>`
    )
    .join("");

  const panel = `
  <Extensions>
    <Panel>
      <Location>Hidden</Location>
      <ActivityType>Custom</ActivityType>
      <Page>
        <PageId>${panelId}</PageId>
        <Name>Are you the meeting host?</Name>
        <Row>${responses}</Row>
        <Options>hideRowNames=1</Options>
      </Page>
    </Panel>
  </Extensions>`;

  return xapi.Command.UserInterface.Extensions.Panel.Save(
    { PanelId: panelId },
    panel
  );
}

async function createKeypad(role) {
  const call = await xapi.Status.Call.get();
  const meetingName =
    call?.[0]?.DisplayName == ""
      ? call?.[0]?.CallbackNumber
      : call?.[0]?.DisplayName;
  const pageTitle = meetingName == "" ? "Meeting" : meetingName;
  const panelId = config.panelId;
  const instruction = localization.enterPinPrompts?.[role] ?? "Enter PIN";

  const layout = [
    ["instructions"],
    ["display"],
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["⌫", "0", "#"],
    ["", "Back", ""],
  ];

  const rows = layout.map((row) => {
    const newRow = row.map((item) => {
      switch (item) {
        case "instructions":
          return `<Widget>
                    <WidgetId>${panelId}-instruction</WidgetId>
                    <Name>${instruction}</Name>
                    <Type>Text</Type>
                    <Options>size=3;fontSize=normal;align=center</Options>
                  </Widget>`;
        case "display":
          return `<Widget>
                    <WidgetId>${panelId}-display</WidgetId>
                    <Name></Name>
                    <Type>Text</Type>
                    <Options>size=3;fontSize=normal;align=center</Options>
                  </Widget>`;
        case "":
          return `<Widget>
                    <WidgetId>${panelId}-spacer</WidgetId>
                    <Type>Spacer</Type>
                    <Options>size=1</Options>
                  </Widget>`;
        default:
          return `<Widget>
                    <WidgetId>${panelId}-key-${item}-${
            role ?? "Guest"
          }</WidgetId>
                    <Name>${item}</Name>
                    <Type>Button</Type>
                    <Options>size=1</Options>
                  </Widget>`;
      }
    });
    return `<Row>${newRow}</Row>`;
  });

  const panel = `
  <Extensions>
    <Panel>
      <Location>Hidden</Location>
      <ActivityType>Custom</ActivityType>
      <Page>
        <PageId>${panelId}</PageId>
        <Name>${pageTitle}</Name>
        ${rows}
        <Options>hideRowNames=1</Options>
      </Page>
    </Panel>
  </Extensions>`;

  return xapi.Command.UserInterface.Extensions.Panel.Save(
    { PanelId: panelId },
    panel
  );
}
