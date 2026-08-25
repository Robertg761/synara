package com.synara.android.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageAttachmentTest {
    @Test
    fun parsesTheServerDescriptor() {
        val attachment = MessageAttachment.fromJson(
            JSONObject()
                .put("id", "att_v2_123")
                .put("name", "screenshot.png")
                .put("mimeType", "image/png")
                .put("sizeBytes", 2048)
                .put("type", "image"),
        )!!
        assertEquals("att_v2_123", attachment.id)
        assertEquals("screenshot.png", attachment.name)
        assertTrue(attachment.isImage)
    }

    @Test
    fun imageMimeCountsEvenWithoutTheTypeHint() {
        val attachment = MessageAttachment.fromJson(
            JSONObject().put("id", "a1").put("mimeType", "IMAGE/JPEG"),
        )!!
        assertTrue("mime case must not decide rendering", attachment.isImage)
    }

    @Test
    fun nonImageFilesAreNotImages() {
        val attachment = MessageAttachment.fromJson(
            JSONObject().put("id", "a2").put("mimeType", "text/plain").put("type", "file"),
        )!!
        assertFalse(attachment.isImage)
    }

    @Test
    fun anAttachmentWithoutAnIdIsUnusableAndDropped() {
        assertNull(MessageAttachment.fromJson(JSONObject().put("name", "mystery.bin")))
    }

    @Test
    fun messagesCarryTheirAttachments() {
        val message = MessageItem.fromJson(
            JSONObject()
                .put("id", "m1")
                .put("role", "user")
                .put("text", "see attached")
                .put("attachments", org.json.JSONArray().put(JSONObject().put("id", "a1"))),
        )
        assertEquals(1, message.attachments.size)
        assertEquals("a1", message.attachments.first().id)
    }
}
