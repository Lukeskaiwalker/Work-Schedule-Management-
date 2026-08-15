# IDS-Connect 2.5 outbound-cart schema

`warenkorb_senden_2_5.xsd` and `beispielwarenkorb_senden.xml` are ITEK's own
files, kept here so the outbound cart builder can be checked against the
standard rather than against our own idea of it.

Recovered from the Wayback Machine on 2026-08-15; itek.de returns 404 for these
paths today.

    warenkorb_senden_2_5.xsd
      https://web.archive.org/web/20210416030406id_/https://www.itek.de/fileadmin/
      user_upload/itek-website/Beratung/Standardisierung/IDS_Connect/2.5/warenkorb_senden_2_5.xsd
      sha256 e58284fec00dd6f8b4298b733c3ca115b03974d7f15030fc6ffad872329ccf48

    Beispielwarenkorb_senden.xml
      .../2.5/Beispielwarenkorb_senden.xml
      sha256 24455d5c855093422c62ab71b47063c52e4148a04674ba8839a8bb84fab5e931

The example is kept as a control: if it stops validating, the schema or the
validator is at fault rather than our builder.

Note the real path is `Beratung/Standardisierung/`, and filenames are lowercase
with an underscore version suffix — `Warenkorb_senden.xsd` and
`Warenkorb_senden_2-5.xsd` both 404, which is why earlier searches failed.
