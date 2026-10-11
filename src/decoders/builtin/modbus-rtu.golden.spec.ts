// 固件金标准帧回归锁 —— 帧数据提取自 stm32f103-rb-demo feat-modbus-rtu 分支的
// tests/modbus_host_test.c（真 nanoMODBUS 库 + 真寄存器/诊断/工艺量单元的主机验证，
// 逐字节断言）。提取方式：拷贝测试打 dump 补丁（wire_req/expect_tx 处），同宏集编译
// 运行得到「用例名|请求帧|应答帧」清单。每条交换的两侧帧都必须被解码器匹配且字段语义正确。
// 寄存器语义见固件 docs/modbus-point-table.md：holding 0..7 RW scratch、8 uptime、
// 9 version(0x0100)、10..11 JEDEC(W25Q64=0x00EF4017)、12 保存命令、13/14 链路参数、
// 15..21 工艺报警参数；input 0..3 同 uptime/ver/jedec、4..8 工艺量；coil 0=LED；
// discrete 0..3=按键；FC08 诊断/FC22 掩码写/FC23 读写多寄存器/FC43 设备识别。
import { describe, expect, it } from 'vitest'
import { modbusRtuDecoder } from '@/decoders/builtin/modbus-rtu'
import { bytesToHex } from '@/utils/codec/hex'

interface GoldenCase {
  name: string
  request: Uint8Array
  reply: Uint8Array
}

const GOLDEN = `
  1a FC16 seed 8 scratch regs echoes|0110000000081010001001100210031004100510061007FAED|011000000008C1CF
  1b FC03 scratch 0..1|010300000002C40B|0103041000100132F3
  2a FC06 reg 5 = 0xCAFE echoes|01060005CAFE4EEB|01060005CAFE4EEB
  2b FC03 reg 5 reads back 0xCAFE|010300050001940B|010302CAFE6F64
  3a FC16 regs 2..3 = {1234,5678} echoes|01100002000204123456780942|011000020002E008
  3b FC03 reads them back|01030002000265CB|010304123456788107
  4a FC05 coil 0 ON echoes|01050000FF008C3A|01050000FF008C3A
  4c FC01 coil 0 reads 1|010100000001FDCA|010101019048
  4d FC05 coil 0 OFF echoes|010500000000CDCA|010500000000CDCA
  4f FC01 coil 0 reads 0|010100000001FDCA|010101005188
  5 FC02 keys {1,0,1,0} -> 0x05|01020000000479C9|01020105618B
  6 FC04 0..3 = uptime/ver/jedec|010400000004F1C9|01040804D2010000EF40179619
  7 FC03 holding 8..11 live values|010300080004C5CB|01030804D2010000EF401727C3
  8 FC03 addr6 qty4 mixes scratch+live|010300060004A408|0103081006100704D20100E512
  9a FC03 addr 22 (past the alarm block) -> 02|01030016000165CE|018302C0F1
  9b FC03 addr 21 qty 2 (wd + 1) -> 02|010300150002D5CF|018302C0F1
  9c FC04 addr 6 qty 4 (past the inputs) -> 02|01040006000411C8|018402C2C1
  9d FC01 qty 2 (only coil 0 exists) -> 02|010100000002BDCB|018102C191
  9e FC02 addr 1 qty 4 (past inputs) -> 02|0102000100042809|018202C161
  9f FC06 reg 8 (live is read-only) -> 02|010600081111C454|018602C3A1
  9g FC06 reg 22 (past the alarm block) -> 02|010600160001A9CE|018602C3A1
  10a FC16 addr7 qty2 (crosses) -> 02|01100007000204DEADBEEF29AC|019002CDC1
  10b reg 7 untouched by the rejected write|01030007000135CB|0103021007F446
  11a FC15 coil 0 = ON echoes|010F000000010101EF57|010F00000001940B
  11c FC01 confirms coil 0 = 1|010100000001FDCA|010101019048
  11d FC15 qty 2 (only coil 0 exists) -> 02|010F0000000201039E96|018F02C5F1
  11e 255-byte FC15 (1968 coils) -> map cap 02|010F000007B0F6FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE875|018F02C5F1
  12a FC07 (unsupported) -> illegal function|01070000000175CA|0187018230
  12b FC20 (trimmed by NMBS_* macros) -> 01|01140E06000400010002188F|0194018F00
  13a FC03 qty 0 -> 03|01030000000045CA|0183030131
  13b FC03 qty 126 (>125) -> 03|01030000007EC5EA|0183030131
  13c FC05 value 0x1234 (not FF00/0000) -> 03|010500001234C0BD|0185030291
  13d FC16 byte count != 2*qty -> 03|0110000000020201022645|0190030C01
  14d server serves the next good frame|010300000001840A|0103021000B584
  16b broadcast FC16 landed|010300000001840A|0103025A5A02DF
  18a 255-byte FC16 -> map cap 02, no hang|01100000007BF61111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111117623|019002CDC1
  18f server alive after the ceiling cases|010300000001840A|0103025A5A02DF
  19 seed scratch 0..7 = 0x2000..0x2007|01100000000810200020012002200320042005200620078392|011000000008C1CF
  19 full-table read addr0 qty22 (49 B)|010300000016C404|01032C2000200120022003200420052006200704D2010000EF40170000000100060352FE702AF80BB8000000000000058A
  20 seed scratch 0..7 = 0x2000..0x2007|01100000000810200020012002200320042005200620078392|011000000008C1CF
  20a paged block addr0 qty4|0103000000044409|01030820002001200220035EAE
  20b paged block addr4 qty4|01030004000405C8|0103082004200520062007AAAC
  20c paged block addr8 qty4|010300080004C5CB|01030804D2010000EF401727C3
  20d paged block addr12 qty4|0103000C0004840A|0103080000000100060352C91B
  20e paged block addr16 qty4|01030010000445CC|010308FE702AF80BB800004EC7
  20f paged block addr20 qty2|010300140002840F|01030400000000FA33
  21a FC06 reg12 wrong magic -> 03|0106000C123444BE|0186030261
  21c FC06 reg12 0x5AA5 echoes|0106000C5AA5B312|0106000C5AA5B312
  21e reg12 readback = save sequence 1|0103000C00014409|01030200017984
  21f refused store -> exception 04|0106000C5AA5B312|01860443A3
  21h readback = save sequence 2|0103000C00014409|01030200023985
  21i FC16 at reg12 -> 02 (FC06-only command)|0110000C0001025AA55C47|019002CDC1
  21j FC06 at RO live reg 8 -> 02|010600080001C9C8|018602C3A1
  22 seed scratch 0..7 = 0x2000..0x2007|01100000000810200020012002200320042005200620078392|011000000008C1CF
  22a FC22 reg3 echo|0116000300FFA000FA36|0116000300FFA000FA36
  22b mask result (cur&and)|(or&~and)|010300030001740A|010302A0038045
  22c FC22 clear bits echoes|011600030FFF00008122|011600030FFF00008122
  22d bits cleared|010300030001740A|0103020003F845
  22e FC22 reg8 (RO live) -> 02|011600080000FF005637|019602CE61
  22f FC22 reg12 (save cmd) -> 02|0116000C0000FF00A7F7|019602CE61
  22h broadcast mask did not land (reg2 = 0x2002)|01030002000125CA|01030220022045
  23 seed scratch 0..7 = 0x2000..0x2007|01100000000810200020012002200320042005200620078392|011000000008C1CF
  23a FC23 write-before-read on overlap|0117000000020001000204BEEFCAFEC471|0117042000BEEFC2CB
  23b FC23 read live block + write scratch|01170008000500000001021234D9C0|01170A04D2010000EF401700032028
  23c FC23 write to live block -> 02|0117000000010008000102000055E6|019702CFF1
  24a FC43 basic: vendor/code/revision|012B0E01007077|012B0E018300000300096B616C693230313737010E52422D44454D4F2D4D4F444255530205312E302E306273
  24b FC43 single object (model name)|012B0E0405B324|012B0E0483000001050D4E55434C454F2D4631303352421E91
  24c FC43 basic @ object 5 -> 02|012B0E0105B074|01AB02DEF1
  24d FC43 wrong MEI -> 01|012B0F010021B7|01AB019EF0
  24e FC43 object 0x63 (gap) -> 02|012B0E0463330E|01AB02DEF1
  24f FC43 regular stream (url/name/model/app)|012B0E02033086|012B0E0283000004031D68747470733A2F2F67697465652E636F6D2F6B616C695F6D7566617361041B53544D3332463130335242204D6F64627573205254552064656D6F050D4E55434C454F2D463130335242060772622D64656D6F455C
  25a FC08 return query data (echo)|01080000DEAD7816|01080000DEAD7816
  25b FC08 restart comm option -> 03|01080001A500CA9B|0188030601
  25c FC08 ascii input delimiter -> 03|01080003002B5014|0188030601
  25d FC08 force listen only mode -> 03|01080004FFFFA07A|0188030601
  25e FC08 diagnostic register reads 0|01080002000041CB|01080002000041CB
  25f FC08 slave message count = rx_ok|0108000E000081C8|0108000E00520035
  25i FC08 exception count readback|0108000D000071C8|0108000D001F3000
  25j FC08 clear counters echoes 0|0108000A0000C009|0108000A0000C009
  25l diagnostic register still 0 after clear|01080002000041CB|01080002000041CB
  25m FC08 unknown sub-function -> 03|010800F00000E038|0188030601
  25o FC08 bus message count (no exception double-count)|0108000B000091C9|0108000B0004900A
  26a FC03 link pair defaults (1, 6)|0103000D000255C8|010304000100062BF1
  26b FC06 holding 13 = 2 echoes|0106000D000299C8|0106000D000299C8
  26c pending pair reads back (2, 6)|0103000D000255C8|01030400020006DBF1
  26d FC06 address 0 -> 03 (broadcast)|0106000D00001809|0186030261
  26e FC06 address 248 -> 03 (reserved)|0106000D00F8198B|0186030261
  26f FC06 address 247 (top) echoes|0106000D00F7598F|0106000D00F7598F
  26g FC06 baud code 0 (2400) echoes|0106000E0000E809|0106000E0000E809
  26h FC06 baud code 7 -> 03|0106000E0007A9CB|0186030261
  26i FC16 link pair {3, 2} echoes|0110000D0002040003000243F7|0110000D0002D00B
  26j FC16 block 12..13 (save cmd) -> 02|0110000C00020400000000F3FA|019002CDC1
  26k FC16 block 13..15 -> 02|0110000D000306000000000000777A|019002CDC1
  26l FC22 at 13 -> 02 (mask write is scratch-only)|0116000D00000000DBC7|019602CE61
  26w FC23 writes the link pair and reads it back|0117000D0002000D00020400020006CAC8|01170400020006D8E5
  27a fresh inputs 4..8: zero caches, quiet status|01040004000571C8|01040A00000000000003E803E851B3
  27c inputs 4..8 carry the fresh samples|01040004000571C8|01040A00FA27940000000000003DEE
  27d FC06 holding 15 = 24.0 °C echoes|0106000F00F0B98D|0106000F00F0B98D
  27e temperature high bit set by the write|010400060001D1CB|010402000178F0
  27g FC06 holding 19 = 2.0 °C echoes|0106001300147800|0106001300147800
  27j FC06 holding 19 = 0 echoes|010600130000780F|010600130000780F
  27m FC06 holding 16 = 86.0 °C -> 03|01060010035C88C6|0186030261
  27n FC06 holding 15 = 85.0 °C echoes|0106000F035238C4|0106000F035238C4
  27o FC06 holding 16 = 25.0 °C echoes|0106001000FA084C|0106001000FA084C
  27q FC06 holding 15 below the low limit -> 03|0106000F00C8B85F|0186030261
  27r FC06 holding 16 = 85.1 °C -> 03|010600100353C8C2|0186030261
  27s rejected writes left the pair alone|0103000F0002F408|010304035200FADBE5
  27t FC06 holding 17 = 1010.0 hPa echoes|010600112774C218|010600112774C218
  27v FC06 holding 18 above the high limit -> 03|0106001227D83265|0186030261
  27w FC06 holding 17 = 1015.0 hPa echoes|0106001127A64245|0106001127A64245
  27y FC06 holding 18 = 1014.0 hPa echoes|01060012279C3256|01060012279C3256
  28a FC16 15..17 = {850,-400,11000} echoes|0110000F0003060352FE702AF8419E|0110000F0003B00B
  28b block landed as read back|0103000F000335C8|0103060352FE702AF8B65B
  28c FC16 15..16 high below low -> 03|0110000F00020400640352733D|0190030C01
  28e FC16 20..22 (past the block) -> 02|01100014000306000000000000A6C0|019002CDC1
  28f FC16 12..15 (crosses the gap) -> 02|0110000C0004080000000000003572311F|019002CDC1
  28g seed scratch 0..7 = 0x2000..0x2007|01100000000810200020012002200320042005200620078392|011000000008C1CF
  28h FC23 writes 15..16 and reads 0..1 back|011700000002000F0002040352FE706711|011704200020012AE7
  28i FC23 write half into 12..13 -> 02|011700000001000C0002045AA50006B5E3|019702CFF1
  29a FC16 restores the 7 alarm defaults|0110000F00070E0352FE702AF80BB8000000000000C948|0110000F0007B1C8
  29c disabled watchdog: bit 5 clear, age still counted|01040006000291CA|01040400000258FB1E
  29d FC06 holding 21 = 3 s echoes|010600150003D80F|010600150003D80F
  29f first status read reports the loss|010400060001D1CB|0104020020B8E8
  29g second read: not currently lost -> clear|010400060001D1CB|0104020000B930
  29i returning master still sees the loss|010400060001D1CB|0104020020B8E8
  29j and the next read is clean again|010400060001D1CB|0104020000B930
  29k FC06 holding 21 = 0 (disabled) echoes|010600150000980E|010600150000980E
  29q FC06 holding 21 = 3 s again|010600150003D80F|010600150003D80F
  29t unicast read still sees the loss|010400060001D1CB|0104020020B8E8
  29u next read is clean|010400060001D1CB|0104020000B930
  29v FC06 holding 21 = 0 restores the default|010600150000980E|010600150000980E
  30a FC06 holding 15 = 25.0 °C echoes|0106000F00FA398A|0106000F00FA398A
  31a -14.8 °C encodes as 0xFF6C|010400040002300A|010404FF6C279411D2
  31d a covering read returns the latch and clears it|010400060003500A|0104060020000000052157
`

const golden: GoldenCase[] = GOLDEN.trim()
  .split('\n')
  .map((line) => line.trim())
  .map((line) => {
    const parts = line.split('|')
    const rep = parts.pop()!
    const req = parts.pop()!
    const name = parts.join('|')
    const toBytes = (hex: string) => {
      const out = new Uint8Array(hex.length / 2)
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      return out
    }
    return { name, request: toBytes(req), reply: toBytes(rep) }
  })

function field(result: { fields?: { name: string; value: string; number?: number | number[] }[] }, name: string) {
  const f = result.fields?.find((x) => x.name === name)
  expect(f, `field ${name} missing`).toBeDefined()
  return f!
}

function u16(pdu: Uint8Array, i: number): number {
  return (pdu[i] << 8) | pdu[i + 1]
}

/** 与解码器同判别：FC03/04/23 的响应 byteCount 恒为偶数且 = len-1 */
function isRegisterResponse(pdu: Uint8Array): boolean {
  return pdu.length >= 2 && pdu[0] === pdu.length - 1 && pdu[0] % 2 === 0
}

describe('modbus-rtu × 固件金标准帧（rb-demo feat-modbus-rtu 主机测试）', () => {
  it('金标准清单完整（134 条交换）', () => {
    expect(golden.length).toBe(134)
  })

  it.each(golden.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    for (const frame of [c.request, c.reply]) {
      const r = modbusRtuDecoder.decode(frame)
      expect(r.matched, bytesToHex(frame)).toBe(true)
      expect(field(r, 'slave').number).toBe(frame[0])
      expect(field(r, 'fc').number).toBe(frame[1])
      expect(field(r, 'crc').value).toBe(bytesToHex(frame.subarray(frame.length - 2)))
    }

    const req = modbusRtuDecoder.decode(c.request)
    const rep = modbusRtuDecoder.decode(c.reply)
    const reqFc = c.request[1]
    const repFc = c.reply[1]
    const reqPdu = c.request.subarray(2, c.request.length - 2)
    const repPdu = c.reply.subarray(2, c.reply.length - 2)

    // ── 请求侧 ──
    if (reqFc >= 0x01 && reqFc <= 0x04) {
      expect(field(req, 'reg').number).toBe(u16(reqPdu, 0))
      expect(field(req, 'count').number).toBe(u16(reqPdu, 2))
    } else if (reqFc === 0x05 || reqFc === 0x06) {
      expect(field(req, 'reg').number).toBe(u16(reqPdu, 0))
      expect(field(req, 'value').number).toBe(u16(reqPdu, 2))
    } else if (reqFc === 0x0f || reqFc === 0x10) {
      expect(field(req, 'reg').number).toBe(u16(reqPdu, 0))
      expect(field(req, 'count').number).toBe(u16(reqPdu, 2))
      expect(field(req, 'byteCount').number).toBe(reqPdu[4])
      expect(field(req, 'data').value).toBe(bytesToHex(reqPdu.subarray(5)))
    } else if (reqFc === 0x08) {
      expect(field(req, 'subfn').number).toBe(u16(reqPdu, 0))
      expect(field(req, 'data').value).toBe(bytesToHex(reqPdu.subarray(2)))
    } else if (reqFc === 0x16) {
      expect(field(req, 'reg').number).toBe(u16(reqPdu, 0))
      expect(field(req, 'andMask').number).toBe(u16(reqPdu, 2))
      expect(field(req, 'orMask').number).toBe(u16(reqPdu, 4))
    } else if (reqFc === 0x17 && !isRegisterResponse(reqPdu)) {
      expect(field(req, 'readReg').number).toBe(u16(reqPdu, 0))
      expect(field(req, 'readCount').number).toBe(u16(reqPdu, 2))
      expect(field(req, 'writeReg').number).toBe(u16(reqPdu, 4))
      expect(field(req, 'writeCount').number).toBe(u16(reqPdu, 6))
      expect(field(req, 'byteCount').number).toBe(reqPdu[8])
      expect(field(req, 'data').value).toBe(bytesToHex(reqPdu.subarray(9)))
    } else if (reqFc === 0x2b) {
      expect(field(req, 'meiType').number).toBe(reqPdu[0])
      if (reqPdu[0] === 0x0e && reqPdu.length === 3) {
        expect(field(req, 'deviceIdCode').number).toBe(reqPdu[1])
        expect(field(req, 'objectId').number).toBe(reqPdu[2])
      }
    }

    // ── 应答侧 ──
    if (repFc >= 0x80) {
      expect(field(rep, 'exception').number).toBe(repPdu[0])
    } else if ((repFc === 0x03 || repFc === 0x04) || (repFc === 0x17 && isRegisterResponse(repPdu))) {
      const regs: number[] = []
      for (let i = 1; i + 1 < repPdu.length; i += 2) regs.push(u16(repPdu, i))
      expect(field(rep, 'byteCount').number).toBe(repPdu[0])
      expect(field(rep, 'registers').number).toEqual(regs)
    } else if (repFc === 0x01 || repFc === 0x02) {
      expect(field(rep, 'byteCount').number).toBe(repPdu[0])
      expect(field(rep, 'coils').value).toBe(bytesToHex(repPdu.subarray(1)))
    } else if (repFc === 0x05 || repFc === 0x06) {
      expect(field(rep, 'reg').number).toBe(u16(repPdu, 0))
      expect(field(rep, 'value').number).toBe(u16(repPdu, 2))
    } else if (repFc === 0x0f || repFc === 0x10) {
      expect(field(rep, 'reg').number).toBe(u16(repPdu, 0))
      expect(field(rep, 'count').number).toBe(u16(repPdu, 2))
    } else if (repFc === 0x08) {
      expect(field(rep, 'subfn').number).toBe(u16(repPdu, 0))
      expect(field(rep, 'data').value).toBe(bytesToHex(repPdu.subarray(2)))
    } else if (repFc === 0x16) {
      expect(field(rep, 'reg').number).toBe(u16(repPdu, 0))
      expect(field(rep, 'andMask').number).toBe(u16(repPdu, 2))
      expect(field(rep, 'orMask').number).toBe(u16(repPdu, 4))
    } else if (repFc === 0x2b && repPdu[0] === 0x0e && repPdu.length >= 6) {
      expect(field(rep, 'deviceIdCode').number).toBe(repPdu[1])
      expect(field(rep, 'conformity').number).toBe(repPdu[2])
      expect(field(rep, 'objectCount').number).toBe(repPdu[5])
      expect(field(rep, 'deviceId')).toBeDefined()
    }
  })

  it('语义抽查：FC04 输入表 0..3 = uptime/版本/JEDEC 高低位', () => {
    const c = golden.find((x) => x.name.startsWith('6 FC04'))!
    const r = modbusRtuDecoder.decode(c.reply)
    expect(field(r, 'registers').number).toEqual([0x04d2, 0x0100, 0x00ef, 0x4017])
  })

  it('语义抽查：全表读 22 个保持寄存器（49B 最大交换，含链路对与报警缺省）', () => {
    const c = golden.find((x) => x.name.includes('full-table read'))!
    const r = modbusRtuDecoder.decode(c.reply)
    expect(field(r, 'registers').number).toEqual([
      0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, // scratch 种子
      0x04d2, 0x0100, 0x00ef, 0x4017, // uptime / 版本 / JEDEC
      0x0000, // 保存序号（本会话 0 次）
      0x0001, 0x0006, // 链路参数缺省：地址 1、波特率代码 6(115200)
      0x0352, 0xfe70, 0x2af8, 0x0bb8, 0x0000, 0x0000, 0x0000, // 报警四参数 + 回差 + 看门狗缺省
    ])
  })

  it('语义抽查：FC43/14 设备识别对象 = 点表 §6 的三个 basic 对象', () => {
    const c = golden.find((x) => x.name.includes('FC43 basic: vendor'))!
    const r = modbusRtuDecoder.decode(c.reply)
    const id = field(r, 'deviceId').value
    expect(id).toContain('kali20177')
    expect(id).toContain('RB-DEMO-MODBUS')
    expect(id).toContain('1.0.0')
    expect(field(r, 'objectCount').number).toBe(3)
  })

  it('语义抽查：FC08 从站消息计数子功能回 u16 BE 计数值', () => {
    const c = golden.find((x) => x.name.includes('25f FC08 slave message count'))!
    const r = modbusRtuDecoder.decode(c.reply)
    expect(field(r, 'subfn').number).toBe(0x000e)
    expect(field(r, 'count').number).toBe(0x0052)
  })

  it('坏 CRC 帧（用例 14 同款）不匹配，保持原始视图', () => {
    const good = golden.find((x) => x.name.includes('14d'))!.request
    const bad = good.slice()
    bad[bad.length - 1] ^= 0xff
    expect(modbusRtuDecoder.decode(good).matched).toBe(true)
    expect(modbusRtuDecoder.decode(bad).matched).toBe(false)
  })

  it('极值帧：255 字节 FC15（1968 线圈）请求解码完整，byteCount 与线圈数据分离', () => {
    const c = golden.find((x) => x.name.includes('255-byte FC15'))!
    const r = modbusRtuDecoder.decode(c.request)
    expect(r.matched).toBe(true)
    expect(field(r, 'count').number).toBe(1968)
    expect(field(r, 'byteCount').number).toBe(246)
    expect(field(r, 'data').value).toBe(bytesToHex(new Uint8Array(246).fill(0xff)))
  })
})
